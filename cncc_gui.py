#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CCF 数字图书馆视频下载器 - 图形界面版
输入视频详情页链接（或 id），选择清晰度，点"下载"即可。

用法: python ccf_gui.py
依赖: requests（pip install requests）、Python 自带 tkinter
"""
import os
import re
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import requests

API = "https://dl.ccf.org.cn/video/findVideoById"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://dl.ccf.org.cn/"}
API_HEADERS = dict(HEADERS, **{"X-Requested-With": "XMLHttpRequest",
                               "Origin": "https://dl.ccf.org.cn"})

QUALITIES = [
    ("自动（最高可用画质）", "best"),
    ("高清", "gao"),
    ("标清", "biao"),
    ("低清", "di"),
    ("音频 mp3", "audio_full"),
    ("试看片段", "try_see"),
]
BEST_ORDER = ["gao", "biao", "di"]
KEY_MAP = {"gao": ("gao_definition", "高清"), "biao": ("biao_definition", "标清"),
           "di": ("di_definition", "低清"), "try_see": ("try_see", "试看"),
           "audio_full": ("audio_full", "音频")}


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"


def extract_id(text):
    text = text.strip()
    m = re.search(r"[?&]id=(\d+)", text) or re.search(r"(\d{12,})", text)
    return m.group(1) if m else None


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name).strip(" .")
    return name[:150] or "ccf_video"


class App:
    def __init__(self, root):
        self.root = root
        root.title("CCF 视频下载器")
        root.geometry("680x460")
        root.minsize(560, 400)

        self.worker = None       # 下载线程
        self.cancel = threading.Event()

        frm = ttk.Frame(root, padding=10)
        frm.pack(fill="both", expand=True)

        # ---- 输入区 ----
        ttk.Label(frm, text="视频链接或 id：").grid(row=0, column=0, sticky="w")
        self.url_var = tk.StringVar(
            value="https://dl.ccf.org.cn/video/videoDetail.html?_ack=1&id=8246130142496768")
        self.url_entry = ttk.Entry(frm, textvariable=self.url_var)
        self.url_entry.grid(row=0, column=1, sticky="ew", padx=(5, 5), ipady=2)

        ttk.Label(frm, text="清晰度：").grid(row=1, column=0, sticky="w", pady=(8, 0))
        self.q_var = tk.StringVar(value=QUALITIES[0][0])
        self.q_box = ttk.Combobox(frm, textvariable=self.q_var, state="readonly",
                                  values=[label for label, _ in QUALITIES], width=20)
        self.q_box.grid(row=1, column=1, sticky="w", pady=(8, 0))
        self.q_box.set(QUALITIES[0][0])

        ttk.Label(frm, text="保存到：").grid(row=2, column=0, sticky="w", pady=(8, 0))
        self.dir_var = tk.StringVar(value=os.path.join(os.getcwd(), "downloads"))
        ttk.Entry(frm, textvariable=self.dir_var).grid(row=2, column=1, sticky="ew", pady=(8, 0))
        ttk.Button(frm, text="浏览…", command=self.choose_dir).grid(row=2, column=2, padx=5)

        # ---- 按钮区 ----
        btns = ttk.Frame(frm)
        btns.grid(row=3, column=0, columnspan=3, sticky="w", pady=(12, 6))
        self.dl_btn = ttk.Button(btns, text="下载", command=self.start)
        self.dl_btn.pack(side="left")
        self.stop_btn = ttk.Button(btns, text="取消", command=self.stop, state="disabled")
        self.stop_btn.pack(side="left", padx=6)

        # ---- 进度条 ----
        self.progress = ttk.Progressbar(frm, mode="determinate")
        self.progress.grid(row=4, column=0, columnspan=3, sticky="ew", pady=(6, 2))
        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(frm, textvariable=self.status_var).grid(row=5, column=0, columnspan=3, sticky="w")

        # ---- 日志区 ----
        self.log_text = tk.Text(frm, height=12, wrap="word", state="disabled",
                                font=("Consolas", 9))
        self.log_text.grid(row=6, column=0, columnspan=3, sticky="nsew", pady=(8, 0))
        sb = ttk.Scrollbar(frm, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.grid(row=6, column=3, sticky="ns", pady=(8, 0))

        frm.columnconfigure(1, weight=1)
        frm.rowconfigure(6, weight=1)

    # ---------- UI 辅助 ----------
    def log(self, msg):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", msg + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def set_status(self, msg):
        self.root.after(0, self.status_var.set, msg)

    def choose_dir(self):
        d = filedialog.askdirectory(initialdir=self.dir_var.get() or ".")
        if d:
            self.dir_var.set(d)

    def stop(self):
        self.cancel.set()
        self.set_status("正在取消…")

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        target = self.url_var.get()
        res_id = extract_id(target)
        if not res_id:
            messagebox.showerror("错误", "无法从输入中解析视频 id，请检查链接。")
            return
        quality = dict(QUALITIES)[self.q_var.get()]
        out_dir = self.dir_var.get().strip() or "."
        os.makedirs(out_dir, exist_ok=True)

        self.cancel.clear()
        self.dl_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.progress.configure(value=0)
        self.log(f"—— 开始处理 {res_id}（{self.q_var.get()}）——")
        self.worker = threading.Thread(
            target=self.run, args=(res_id, quality, out_dir), daemon=True)
        self.worker.start()

    def finish(self, ok):
        self.dl_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.set_status("完成" if ok else "失败/已取消")

    # ---------- 下载逻辑 ----------
    def run(self, res_id, quality, out_dir):
        try:
            info = self.fetch_info(res_id)
            addr = info["video_audio_address"]
            title = sanitize(info.get("title") or f"ccf_{res_id}")
            self.log(f"标题: {title}")

            if quality == "best":
                order = BEST_ORDER
            else:
                order = [quality]
            picked = None
            for q in order:
                key, label = KEY_MAP[q]
                url = addr.get(key)
                if not url:
                    continue
                ok, total = self.probe(url)
                if ok and total > 0:
                    picked = (q, label, url, total)
                    break
                self.log(f"{label}不可用，尝试其他…")
            if not picked:
                raise RuntimeError("没有可用的下载地址（签名失效或需要登录）")

            q, label, url, total = picked
            ext = ".mp3" if q == "audio_full" else ".mp4"
            path = os.path.join(out_dir, title + ("_sd" if q == "biao" else "") + ext)
            self.log(f"质量: {label}    大小: {human(total)}")
            if os.path.exists(path) and os.path.getsize(path) == total:
                self.log(f"文件已存在且完整: {path}")
                self.set_status(f"已存在: {path}")
                self.finish(True)
                return
            self.download(url, path, total)
            self.log(f"完成: {path} ({human(os.path.getsize(path))})")
            self.set_status(f"完成: {os.path.basename(path)}")
            self.finish(True)
        except Exception as e:  # noqa: BLE001
            self.log(f"! 失败: {e}")
            self.finish(False)

    def fetch_info(self, res_id):
        r = requests.post(API, data={"resId": res_id}, headers=API_HEADERS, timeout=30)
        r.raise_for_status()
        p = r.json()
        if not p.get("success") or not p.get("data", {}).get("video_audio_address"):
            raise RuntimeError(f"接口未返回视频地址: {p.get('msg')}（付费视频需登录 Cookie）")
        return p["data"]

    def probe(self, url):
        try:
            r = requests.get(url, headers=dict(HEADERS, **{"Range": "bytes=0-0"}),
                             timeout=25)
            cr = r.headers.get("Content-Range", "")
            if r.status_code == 206 and "/" in cr:
                return True, int(cr.rsplit("/", 1)[1])
            return False, 0
        except requests.RequestException:
            return False, 0

    def download(self, url, path, total):
        part = path + ".part"
        done = os.path.getsize(part) if os.path.exists(part) else 0
        if done and done >= total:
            done = 0
        r = requests.get(url, headers=dict(HEADERS, **({"Range": f"bytes={done}-"} if done else {})),
                         stream=True, timeout=(20, 120))
        if r.status_code not in (200, 206):
            raise RuntimeError(f"HTTP {r.status_code}")
        start_time = time.time() - 1e-6
        with open(part, "ab" if done else "wb") as f:
            for block in r.iter_content(512 * 1024):
                if self.cancel.is_set():
                    r.close()
                    raise RuntimeError("已取消（进度已保留，可续传）")
                f.write(block)
                done += len(block)
                speed = done / (time.time() - start_time)
                pct = done * 100 / total if total else 0
                self.root.after(0, self._update_progress, pct,
                                f"{human(done)}/{human(total)}  {human(speed)}/s  "
                                f"ETA {time.strftime('%H:%M:%S', time.gmtime((total-done)/max(speed,1)))}")
        self.root.after(0, self._update_progress, 100, "100%")
        os.replace(part, path)

    def _update_progress(self, pct, text):
        self.progress.configure(value=pct)
        self.status_var.set(text)


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
