#!/usr/bin/env python3
"""
论文阅读器本地服务器(纯标准库,无需 pip 安装)
- 托管静态页面(index.html/css/js)
- 所有数据存放在 ./data/ 文件夹,可整体拷贝迁移:
    data/config.json                 多平台 AI 配置
    data/records.json                文献库记录(目录/标注/笔记/对话会话/总结)
    data/papers/<id>/original.pdf    论文原文
    data/papers/<id>/translation.json整篇翻译进度
- /api/ai /api/audio 由服务器转发到 AI 平台,/api/fetch 转发 arXiv(绕开浏览器 CORS)

启动:  python server.py   然后访问 http://localhost:8517
"""
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import urllib.error
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PAPERS = os.path.join(DATA, "papers")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8517
SERVER = None  # 供 /api/stop 优雅关闭


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def cfg_path():
    return os.path.join(DATA, "config.json")


def fix_encoded_dirs():
    """历史遗留:旧版进程创建过 URL 编码(含 %20)的论文文件夹,启动时自动改回正常字符;
    若正确名已存在(同一论文被导入两次),则合并文件后删除编码文件夹"""
    if not os.path.isdir(PAPERS):
        return
    for name in os.listdir(PAPERS):
        dec = unquote(name)
        if dec == name:
            continue
        src, dst = os.path.join(PAPERS, name), os.path.join(PAPERS, dec)
        if not os.path.isdir(src):
            continue
        if os.path.exists(dst):
            for fn in os.listdir(src):
                sp, dp = os.path.join(src, fn), os.path.join(dst, fn)
                if not os.path.exists(dp):
                    shutil.move(sp, dp)
            shutil.rmtree(src)
            print(f"已合并编码文件夹: {name} -> {dec}")
        else:
            os.rename(src, dst)
            print(f"已修复文件夹名: {name} -> {dec}")


def migrate_records():
    """旧版单文件 records.json -> 每篇论文独立 data/papers/<id>/meta.json(一次性)"""
    old = os.path.join(DATA, "records.json")
    if not os.path.isfile(old):
        return
    recs = read_json(old, [])
    for rec in recs:
        if not isinstance(rec, dict) or not rec.get("id"):
            continue
        d = os.path.join(PAPERS, rec["id"])
        meta_file = os.path.join(d, "meta.json")
        if not os.path.isfile(meta_file):
            os.makedirs(d, exist_ok=True)
            write_json(meta_file, rec)
    try:
        os.rename(old, old + ".migrated.bak")
        print("已将旧 records.json 拆分为各论文独立文件夹(原文件备份为 records.json.migrated.bak)")
    except Exception:
        pass


def list_records():
    """扫描 data/papers/*/meta.json 聚合文献库"""
    out = []
    if not os.path.isdir(PAPERS):
        return out
    for pid in os.listdir(PAPERS):
        meta = read_json(os.path.join(PAPERS, pid, "meta.json"), None)
        if isinstance(meta, dict):
            out.append(meta)
    out.sort(key=lambda r: r.get("lastRead") or r.get("addedAt") or 0, reverse=True)
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---------- 基础 ----------
    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, obj):
        return self._send(200, json.dumps(obj, ensure_ascii=False))

    def _err(self, code, msg):
        return self._send(code, json.dumps({"error": msg}, ensure_ascii=False))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self):
        try:
            u = urlparse(self.path)
            path, q = u.path, parse_qs(u.query)
            if path == "/api/config":
                return self._json(read_json(cfg_path(), {}))
            if path == "/api/records":
                return self._json(list_records())
            if path == "/api/stop":
                # 优雅停止:先回应,再等连接关闭后退出主循环
                def _stop():
                    try:
                        SERVER.shutdown()
                    except Exception:
                        pass
                threading.Timer(0.6, _stop).start()
                return self._json({"ok": True, "stopping": True})
            if path == "/api/fetch":
                return self.proxy_fetch(q)
            m = re.match(r"^/api/papers/([^/]+)/pdf$", path)
            if m:
                f = os.path.join(PAPERS, unquote(m.group(1)), "original.pdf")
                if not os.path.isfile(f):
                    return self._err(404, "PDF 不存在")
                with open(f, "rb") as fh:
                    return self._send(200, fh.read(), "application/pdf")
            m = re.match(r"^/api/papers/([^/]+)/translation$", path)
            if m:
                f = os.path.join(PAPERS, unquote(m.group(1)), "translation.json")
                return self._json(read_json(f, {}))
            return self.static(path)
        except Exception as e:
            return self._err(500, str(e))

    # ---------- PUT ----------
    def do_PUT(self):
        try:
            path = urlparse(self.path).path
            body = self._body()
            if path == "/api/config":
                write_json(cfg_path(), json.loads(body))
                return self._json({"ok": True})
            m = re.match(r"^/api/papers/([^/]+)/meta$", path)
            if m:
                # 每篇论文的 meta 存入自己的文件夹
                write_json(os.path.join(PAPERS, unquote(m.group(1)), "meta.json"), json.loads(body))
                return self._json({"ok": True})
            m = re.match(r"^/api/papers/([^/]+)/pdf$", path)
            if m:
                d = os.path.join(PAPERS, unquote(m.group(1)))
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, "original.pdf"), "wb") as f:
                    f.write(body)
                return self._json({"ok": True})
            m = re.match(r"^/api/papers/([^/]+)/translation$", path)
            if m:
                write_json(os.path.join(PAPERS, unquote(m.group(1)), "translation.json"), json.loads(body))
                return self._json({"ok": True})
            return self._err(404, "未知接口")
        except Exception as e:
            return self._err(500, str(e))

    # ---------- POST ----------
    def do_POST(self):
        try:
            u = urlparse(self.path)
            q = parse_qs(u.query)
            body = self._body()
            if u.path == "/api/ai":
                return self.ai_relay(body)
            if u.path == "/api/audio":
                return self.audio_relay(body, q)
            if u.path == "/api/models":
                return self.models_relay(body)
            return self._err(404, "未知接口")
        except Exception as e:
            return self._err(500, str(e))

    # ---------- DELETE ----------
    def do_DELETE(self):
        try:
            m = re.match(r"^/api/papers/([^/]+)$", urlparse(self.path).path)
            if m:
                shutil.rmtree(os.path.join(PAPERS, unquote(m.group(1))), ignore_errors=True)
                return self._json({"ok": True})
            return self._err(404, "未知接口")
        except Exception as e:
            return self._err(500, str(e))

    # ---------- 静态文件 ----------
    def static(self, path):
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not fp.startswith(ROOT) or not os.path.isfile(fp):
            return self._err(404, "文件不存在:" + path)
        ct = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        with open(fp, "rb") as f:
            # no-cache:每次与服务器核对文件是否更新,避免浏览器用旧版 js/css
            return self._send(200, f.read(), ct, {"Cache-Control": "no-cache"})

    # ---------- arXiv 转发(仅放行 arxiv.org,避免被当开放代理) ----------
    def proxy_fetch(self, q):
        url = (q.get("url") or [""])[0]
        if not re.match(r"^https?://([\w-]+\.)?arxiv\.org/", url):
            return self._err(403, "仅允许转发 arxiv.org 的请求")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (paper-reader)"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return self._send(200, r.read(), r.headers.get("Content-Type", "application/octet-stream"))
        except urllib.error.HTTPError as e:
            return self._err(e.code, "arXiv HTTP " + str(e.code))
        except Exception as e:
            return self._err(502, "转发失败:" + str(e))

    # ---------- 模型列表转发(设置界面"拉取模型"按钮) ----------
    def models_relay(self, body):
        p = json.loads(body)
        base = (p.get("baseUrl") or "").rstrip("/")
        if not base:
            return self._err(400, "缺少 baseUrl")
        headers = {}
        if p.get("apiKey"):
            headers["Authorization"] = "Bearer " + p["apiKey"]
        req = urllib.request.Request(base + "/models", headers=headers)
        try:
            r = urllib.request.urlopen(req, timeout=60)
            return self._send(200, r.read(), "application/json")
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), "application/json")
        except Exception as e:
            return self._err(502, "接口不可达:" + str(e))

    # ---------- AI 对话转发(支持流式) ----------
    def ai_relay(self, body):
        payload = json.loads(body)
        # 允许请求自带 baseUrl/apiKey(设置界面测试未保存的平台时使用)
        if payload.get("baseUrl"):
            prov = {"baseUrl": payload["baseUrl"], "apiKey": payload.get("apiKey") or ""}
        else:
            cfg = read_json(cfg_path(), {})
            provs = cfg.get("providers") or []
            prov = next((x for x in provs if x.get("id") == payload.get("providerId")), None) or (provs[0] if provs else None)
            if not prov or not prov.get("baseUrl"):
                return self._err(500, "未配置 AI 平台,请先在 ⚙ AI 设置中配置")
        model = payload.get("model") or (prov.get("models") or [{}])[0].get("id")
        headers = {"Content-Type": "application/json"}
        if prov.get("apiKey"):
            headers["Authorization"] = "Bearer " + prov["apiKey"]
        data = json.dumps({
            "model": model,
            "messages": payload.get("messages"),
            "temperature": payload.get("temperature", 0.2),
            "stream": bool(payload.get("stream")),
        }).encode("utf-8")
        req = urllib.request.Request(prov["baseUrl"].rstrip("/") + "/chat/completions", data=data, headers=headers, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), "application/json")
        except Exception as e:
            return self._err(502, "AI 接口不可达:" + str(e))
        if payload.get("stream"):
            # 以 HTTP chunked 透传上游 SSE
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = r.read(2048)
                    if not chunk:
                        break
                    self.wfile.write(("%x\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except Exception:
                pass
            return
        return self._send(200, r.read(), "application/json")

    # ---------- 语音转写转发 ----------
    def audio_relay(self, body, q):
        cfg = read_json(cfg_path(), {})
        provs = cfg.get("providers") or []
        prov = provs[0] if provs else None
        if not prov or not prov.get("baseUrl"):
            return self._err(500, "未配置 AI 平台")
        model = (q.get("model") or ["whisper-1"])[0]
        filename = (q.get("filename") or ["audio.webm"])[0]
        boundary = "----preader" + uuid.uuid4().hex
        data = b"\r\n".join([
            ("--" + boundary).encode(),
            b'Content-Disposition: form-data; name="model"\r\n\r\n' + model.encode(),
            ("--" + boundary).encode(),
            ('Content-Disposition: form-data; name="file"; filename="%s"' % filename).encode() + b"\r\nContent-Type: application/octet-stream\r\n\r\n" + body,
            ("--" + boundary + "--\r\n").encode(),
        ])
        headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
        if prov.get("apiKey"):
            headers["Authorization"] = "Bearer " + prov["apiKey"]
        req = urllib.request.Request(prov["baseUrl"].rstrip("/") + "/audio/transcriptions", data=data, headers=headers, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=300)
            return self._send(200, r.read(), "application/json")
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), "application/json")
        except Exception as e:
            return self._err(502, "转写接口不可达:" + str(e))


def main():
    os.makedirs(PAPERS, exist_ok=True)
    fix_encoded_dirs()
    migrate_records()
    pidfile = os.path.join(DATA, "server.pid")
    portfile = os.path.join(DATA, "server.port")
    # 已有实例在跑则直接复用:打开浏览器后退出
    old_port = read_json(portfile, None) if os.path.isfile(portfile) else None
    if isinstance(old_port, int):
        try:
            with urllib.request.urlopen(f"http://localhost:{old_port}/api/records", timeout=1.5) as r:
                if r.status == 200:
                    print(f"已有实例运行于 http://localhost:{old_port},直接打开浏览器")
                    webbrowser.open(f"http://localhost:{old_port}")
                    return
        except Exception:
            pass  # 旧实例已死,继续启动新实例
    # 端口自增:从默认端口开始,被占用则依次 +1,最多尝试 50 个
    srv, port = None, PORT
    for p in range(PORT, PORT + 50):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            print(f"端口 {p} 已被占用,尝试 {p + 1} ...")
    if srv is None:
        print(f"错误: {PORT}~{PORT + 49} 端口均被占用")
        sys.exit(1)
    global SERVER
    SERVER = srv
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))
    write_json(portfile, port)
    print(f"论文阅读器已启动: http://localhost:{port} (PID {os.getpid()})")
    print(f"数据目录: {DATA}  (papers/ 下每篇论文一个独立文件夹,可整体拷贝迁移)")
    print(f"停止服务: 运行 stop.bat 或结束 PID {os.getpid()}")
    # 启动 1 秒后自动打开浏览器
    threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        for f in (pidfile, portfile):
            try:
                os.remove(f)
            except Exception:
                pass


if __name__ == "__main__":
    main()
