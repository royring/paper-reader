/* ============================================================
 * 论文阅读器 Paper Reader
 * - PDF 渲染 + 文本选择、AI 翻译(段落/整篇)、AI 总结、AI 对话
 * - OpenAI 兼容 API(内网/外网可配)、公式以 LaTeX 输出并用 KaTeX 渲染
 * - 标注高亮/笔记、历史记录树状目录、论文手动关联关系图
 * ============================================================ */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* #RRGGBB -> rgba(r,g,b,a) */
function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ================= 本地服务器存储(不依赖浏览器 localStorage/IndexedDB) ================= */
const DEFAULT_CONFIG = {
  lang: "中文(简体)",
  providers: [{ id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", models: [{ id: "gpt-4o-mini", name: "" }] }],
  activeProviderId: "p1",
  activeModel: "gpt-4o-mini",
};
let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("读取失败 " + url + ":" + r.status);
  return r.json();
}
async function apiPutJSON(url, obj) {
  const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error("保存失败 " + url + ":" + r.status);
}
let cfgSaveTimer = null;
function saveCfg() {
  clearTimeout(cfgSaveTimer);
  cfgSaveTimer = setTimeout(() => apiPutJSON("/api/config", cfg).catch(e => console.error(e)), 300);
}
/* 当前生效的平台/模型(override 用于对话单独选模型) */
function resolveTarget(override) {
  let prov = null;
  if (override?.providerId) prov = cfg.providers.find((p) => p.id === override.providerId);
  if (!prov) prov = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0];
  if (!prov) prov = { id: "?", name: "默认", baseUrl: DEFAULT_CONFIG.providers[0].baseUrl, apiKey: "", models: [{ id: "gpt-4o-mini", name: "" }] };
  let model = override?.model;
  if (!model && prov.id === cfg.activeProviderId) model = cfg.activeModel;
  if (!model) model = prov.models?.[0]?.id || "gpt-4o-mini";
  return { prov, model };
}

/* ================= AI 对话(经本地 Python 服务器转发,无 CORS 问题) ================= */
async function aiChat(messages, { onDelta, override, direct } = {}) {
  const { prov, model } = resolveTarget(override);
  const resp = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: prov.id, model, messages, temperature: 0.2, stream: !!onDelta,
      // direct:设置界面测试未保存的平台时直接携带连接信息
      ...(direct ? { baseUrl: direct.baseUrl, apiKey: direct.apiKey } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`API 错误 ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  if (!onDelta) {
    const data = await resp.json();
    return data.choices[0].message.content;
  }
  // 流式读取(服务器透传上游 SSE 字节)
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const d = s.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        const t = j.choices?.[0]?.delta?.content || "";
        if (t) { full += t; onDelta(t); }
      } catch (_) { /* 忽略心跳/坏行 */ }
    }
  }
  return full;
}

/* ================= 文件存储(本地服务器 data/ 文件夹) ================= */
async function savePDFBlob(id, blob) {
  const r = await fetch(`/api/papers/${id}/pdf`, { method: "PUT", body: blob });
  if (!r.ok) throw new Error("PDF 保存失败 " + r.status);
}
async function getPDFBlob(id) {
  const r = await fetch(`/api/papers/${id}/pdf`);
  if (!r.ok) return null;
  return r.blob();
}
async function delPaperFiles(id) {
  await fetch(`/api/papers/${id}`, { method: "DELETE" });
}
async function getTranslation(id) {
  try { return await apiGet(`/api/papers/${id}/translation`); } catch (_) { return null; }
}
async function putTranslation(id, obj) {
  await apiPutJSON(`/api/papers/${id}/translation`, obj);
}

/* ================= 文献库记录(服务器 records.json) ================= */
async function loadRecords() {
  try { return await apiGet("/api/records"); } catch (_) { return []; }
}
let recSaveTimer = null;
function saveRecords() {
  // 每篇论文的记录存到服务器自己的文件夹 data/papers/<id>/meta.json
  clearTimeout(recSaveTimer);
  recSaveTimer = setTimeout(async () => {
    for (const rec of state.records) {
      if (!rec?.id) continue;
      try { await apiPutJSON(`/api/papers/${rec.id}/meta`, rec); } catch (e) { console.error(e); }
    }
  }, 400);
}

/* 数学公式翻译系统提示:保证公式正确性 */
const MATH_RULES = `你是一位专业的学术论文翻译与阅读助手。
【最重要的规则——数学公式处理】
1. 论文中的数学公式、变量、符号必须原样保留,并把它们改写为规范 LaTeX:
   - 行内公式用 $...$ 包裹,独立公式用 $$...$$ 包裹(独占一行)。
   - 简单变量(如 x、n、T)也输出为 $x$、$n$、$T$,保证渲染一致。
   - 绝不要把公式"翻译"成自然语言,不要改变下标/上标/希腊字母/算子。
2. 专业术语首次出现时在译名后附上英文原文,例如:卷积神经网络(CNN)。
3. 保留段落结构与列表结构;使用 Markdown 输出。
4. 原文中的乱码或无法识别的字符,尽量依据上下文推断;无法推断则跳过,不要编造公式。
5. LaTeX 中禁止出现 Unicode 数学符号(如 α ∑ × ≤ ∈ ∞),必须写成命令形式(\\alpha、\\sum、\\times、\\le、\\in、\\infty)。`;

async function translateText(text, lang) {
  return aiChat([
    { role: "system", content: MATH_RULES },
    { role: "user", content: `请把下面这段论文文字翻译成${lang}。只输出译文:\n\n"""${text}"""` },
  ]);
}

/* ================= 全局状态 ================= */
const state = {
  records: [],                // 文献库(boot 时从服务器加载)
  pdf: null,                // 当前 PDFDocumentProxy
  record: null,            // 当前论文记录
  scale: 1.2,
  rendered: new Set(),      // 已渲染页码
  pageTexts: {},           // 页码 -> 文本
  chat: [],                // 对话历史
  chatModel: null,         // 对话独立模型 "providerId::model"
  attach: [],             // 对话附件(图片)
  transPages: {},          // 页码 -> 译文(缓存)
};

/* 常见 Unicode 数学符号 -> LaTeX 命令(仅在 $...$ / $$...$$ 内替换) */
const UNI2TEX = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\varepsilon", "ζ": "\\zeta",
  "η": "\\eta", "θ": "\\theta", "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu",
  "ν": "\\nu", "ξ": "\\xi", "π": "\\pi", "ρ": "\\rho", "σ": "\\sigma", "τ": "\\tau",
  "υ": "\\upsilon", "φ": "\\varphi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega",
  "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda", "Ξ": "\\Xi", "Π": "\\Pi",
  "Σ": "\\Sigma", "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint",
  "√": "\\sqrt", "×": "\\times", "⋅": "\\cdot", "∙": "\\bullet", "÷": "\\div",
  "±": "\\pm", "∓": "\\mp", "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx",
  "≡": "\\equiv", "∼": "\\sim", "∝": "\\propto", "∞": "\\infty", "∈": "\\in", "∉": "\\notin",
  "⊂": "\\subset", "⊆": "\\subseteq", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap",
  "∅": "\\emptyset", "∀": "\\forall", "∃": "\\exists", "→": "\\to", "←": "\\leftarrow",
  "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow",
  "∂": "\\partial", "∇": "\\nabla", "ℏ": "\\hbar", "ℓ": "\\ell", "…": "\\dots", "⋯": "\\cdots",
  "⋮": "\\vdots", "⋱": "\\ddots", "⟨": "\\langle", "⟩": "\\rangle", "∥": "\\parallel",
  "⊥": "\\perp", "⊕": "\\oplus", "⊗": "\\otimes", "⊙": "\\odot", "°": "^{\\circ}",
};
function fixMathUnicode(s) {
  return s.replace(/(\$\$?)([^$]+)\1/g, (m, d, c) =>
    d + c.replace(/[^\x00-\x7F]/g, (ch) => UNI2TEX[ch] || ch) + d);
}

/* ================= Markdown + KaTeX 渲染 ================= */
function renderMD(el, mdText) {
  el.innerHTML = marked.parse(fixMathUnicode(mdText || ""), { breaks: true });
  renderMathInElement(el, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
    ],
    throwOnError: false,
  });
}

/* ================= PDF 视图 ================= */
const viewer = $("#viewer");

async function loadPaper(record) {
  const blob = await getPDFBlob(record.id);
  if (!blob) { alert("文件已丢失,请重新打开该 PDF"); return; }
  const buf = await blob.arrayBuffer();
  state.pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  state.record = record;
  state.rendered.clear();
  state.pageTexts = {};
  state.transPages = {};
  state.chat = [];            // 每次打开 HTML/切换论文都是新会话,历史会话保存在 sessions
  state.activeSession = null;
  state.fullSaved = null;
  state.transStore = { current: null, versions: [] };
  $("#empty").style.display = "none";
  viewer.innerHTML = "";
  // 恢复 AI 对话历史
  renderChat();
  // 恢复 AI 总结
  $("#sumResult").innerHTML = "";
  $("#sumStatus").textContent = record.summary ? "" : "";
  if (record.summary) {
    renderMD($("#sumResult"), record.summary);
    $("#sumStatus").textContent = "已保存的总结 · " + new Date(record.summaryAt || Date.now()).toLocaleString();
  }
  // 恢复整篇翻译
  $("#fullResult").innerHTML = "";
  $("#pbarFill").style.width = "0%";
  $("#fullStatus").textContent = "";
  try {
    const store = normalizeTransStore(await getTranslation(record.id));
    state.transStore = store;
    state.fullSaved = activeVersion();
    if (state.fullSaved && Object.keys(state.fullSaved.pages || {}).length) {
      const { done } = showVersion(state.fullSaved);
      $("#fullStatus").textContent = `已恢复上次使用的整篇翻译版本(${done}/${state.fullSaved.total} 页)`;
    }
    renderTransVersions();
  } catch (_) {}
  fullBtnLabel(); // 按钮显示"开始"或"▶ 继续翻译(从第 X 页)"
  for (let p = 1; p <= state.pdf.numPages; p++) {
    const vp1 = await state.pdf.getPage(p).then((pg) => pg.getViewport({ scale: 1 }));
    const box = document.createElement("div");
    box.className = "page-box";
    box.id = "page-" + p;
    box.style.width = (vp1.width * state.scale) + "px";
    box.style.height = (vp1.height * state.scale) + "px";
    box.innerHTML = `<div class="page-num">${p} / ${state.pdf.numPages}</div>`;
    viewer.appendChild(box);
  }
  const io = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) renderPage(parseInt(e.target.id.slice(5))); });
  }, { root: $("#viewerWrap"), rootMargin: "400px" });
  $$(".page-box").forEach((b) => io.observe(b));

  // 恢复阅读进度(只在 PDF 视口内滚动,绝不用 scrollIntoView——它会连带滚动整页文档,把顶栏卷出视野)
  const target = record.lastPage || 1;
  setTimeout(() => {
    const el = $("#page-" + target);
    if (el) $("#viewerWrap").scrollTop = Math.max(0, el.offsetTop - 16);
    // 兜底:确保顶栏可见、整页滚动归零
    const tb = $("#topbar");
    tb.hidden = false;
    document.documentElement.scrollTop = document.body.scrollTop = 0;
  }, 200);
  renderTree();
  renderNotes();
  updatePageCtl();
  saveRecords();
}

async function renderPage(n) {
  if (state.rendered.has(n) || !state.pdf) return;
  state.rendered.add(n);
  const page = await state.pdf.getPage(n);
  const vp = page.getViewport({ scale: state.scale });
  const box = $("#page-" + n);
  box.style.width = vp.width + "px";
  box.style.height = vp.height + "px";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = vp.width * dpr;
  canvas.height = vp.height * dpr;
  canvas.style.width = vp.width + "px";
  canvas.style.height = vp.height + "px";
  ctx.scale(dpr, dpr);
  box.prepend(canvas);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  // 文本层(支持选择/翻译)
  const tl = document.createElement("div");
  tl.className = "textLayer";
  tl.dataset.page = n;
  tl.style.setProperty("--scale-factor", state.scale); // 关键:保证 span 与 canvas 精确对齐、选区准确
  box.appendChild(tl);
  const tc = await page.getTextContent();
  const textDivs = [];
  pdfjsLib.renderTextLayer({
    textContentSource: tc,
    container: tl,
    viewport: vp,
    textDivs,
  });
  // 拼接整页文本(供 AI 使用)
  state.pageTexts[n] = tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  applyHighlights(n);
}

async function getPageText(n) {
  if (state.pageTexts[n]) return state.pageTexts[n];
  if (!state.rendered.has(n)) { await renderPage(n); }
  return state.pageTexts[n] || "";
}

/* 记录阅读进度 + 同步页码控件 + 翻页器浮现控制 */
(() => {
  const wrap = $("#viewerWrap");
  const float = $("#pageFloat");
  let hideTimer = null;
  const showFloat = () => {
    if (float.hidden) return;
    float.classList.add("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => float.classList.remove("show"), 1600); // 停止滚动 1.6s 后淡出
  };
  // 鼠标悬停或正在输入页码时保持可见
  float.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  float.addEventListener("mouseleave", showFloat);
  $("#pageInput").addEventListener("focus", () => clearTimeout(hideTimer));
  $("#pageInput").addEventListener("blur", showFloat);

  wrap.addEventListener("scroll", () => {
    if (!state.pdf) return;
    const boxes = $$(".page-box");
    let cur = 1;
    for (const b of boxes) {
      const r = b.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.5) cur = parseInt(b.id.slice(5));
    }
    if (state.record && state.record.lastPage !== cur) {
      state.record.lastPage = cur;
      state.record.lastRead = Date.now();
      saveRecords();
    }
    const pi = $("#pageInput");
    if (document.activeElement !== pi) pi.value = cur;
    // 已滚到最顶部时不显示翻页器;滚动中或未达底部常态浮现
    if (wrap.scrollTop > 40) showFloat();
    else { float.classList.remove("show"); clearTimeout(hideTimer); }
  });
})();

/* ================= 翻页控件(上下页 + 页码跳转) ================= */
function updatePageCtl() {
  const total = state.pdf?.numPages || 0;
  $("#pageTotal").textContent = total;
  $("#pageInput").max = total || 1;
  $("#pageInput").value = state.record?.lastPage || 1;
  $("#pageFloat").hidden = !total;
  $("#pageInput").disabled = $("#pagePrev").disabled = $("#pageNext").disabled = !total;
}
function gotoPage(n) {
  if (!state.pdf) return;
  const total = state.pdf.numPages;
  n = Math.min(total, Math.max(1, Math.round(n)));
  $("#pageInput").value = n;
  if (state.record) { state.record.lastPage = n; state.record.lastRead = Date.now(); saveRecords(); }
  renderPage(n).then(() => {
    const el = $("#page-" + n);
    if (el) $("#viewerWrap").scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: "smooth" });
    applyHighlights(n);
  });
}
$("#pagePrev").onclick = () => gotoPage((state.record?.lastPage || 1) - 1);
$("#pageNext").onclick = () => gotoPage((state.record?.lastPage || 1) + 1);
$("#pageInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { gotoPage(parseInt(e.target.value) || 1); e.target.blur(); }
});
$("#pageInput").addEventListener("blur", () => { if (state.pdf) $("#pageInput").value = state.record?.lastPage || 1; });

/* 缩放 */
function setScale(s) {
  state.scale = Math.min(3, Math.max(0.5, s));
  $("#zoomVal").textContent = state.scale.toFixed(2).replace(/0$/, "");
  if (state.pdf) { const r = state.record?.lastPage || 1; loadPaper(state.record).then(() => { setTimeout(() => { const el = $("#page-" + r); if (el) $("#viewerWrap").scrollTop = Math.max(0, el.offsetTop - 16); }, 150); }); }
}
$("#zoomIn").onclick = () => setScale(state.scale + 0.2);
$("#zoomOut").onclick = () => setScale(state.scale - 0.2);
/* 鼠标在 PDF 视图上 Ctrl+滚轮:只缩放 PDF,不影响整个页面 */
$("#viewerWrap").addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !state.pdf) return;
  e.preventDefault();
  setScale(state.scale + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

/* ================= 一键复制(总结 / 对话) ================= */
async function copyText(text, btn, okMsg) {
  if (!text) { alert("没有可复制的内容"); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // 非安全上下文回退
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "✅ " + okMsg;
    setTimeout(() => (btn.textContent = old), 1500);
  }
}
$("#btnSumCopy").onclick = () => {
  const text = state.record?.summary || $("#sumResult").innerText.trim();
  copyText(text, $("#btnSumCopy"), "已复制");
};
$("#btnChatCopy").onclick = () => {
  const msgs = (state.activeSession?.messages || state.chat).filter((m) => m.content);
  if (!msgs.length) return alert("当前会话还没有对话内容");
  const text = msgs.map((m) => (m.role === "user" ? "【我】" : "【AI】") + "\n" + m.content).join("\n\n———\n\n");
  copyText(text, $("#btnChatCopy"), "已复制");
};

/* ================= 打开文件 ================= */
$("#btnOpen").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = async (e) => { if (e.target.files[0]) await addPDF(e.target.files[0]); e.target.value = ""; };
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (f) await addPDF(f);
});

async function addPDF(file, meta = {}) {
  // 存储文件夹名与原文件名保持一致;重名时才追加版本号
  const baseName = (meta.title || file.name.replace(/\.pdf$/i, ""))
    .replace(/[\\/:*?"<>|#%^\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名论文";
  let id = baseName, ver = 2;
  while (state.records.some((r) => r.id === id)) id = `${baseName} (${ver++})`;
  await savePDFBlob(id, file);
  const rec = {
    id, name: file.name, title: meta.title || baseName,
    folder: meta.folder || "未分类", addedAt: Date.now(), lastPage: 1,
    relations: [], annotations: [],
  };
  // 取第一页文本作为标题线索(外部元数据优先)
  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const t = tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    const m = t.match(/([A-Z][\w\s,\-:]{8,80})/);
    if (!meta.title && m) rec.title = m[1].trim().slice(0, 80);
  } catch (_) {}
  state.records.push(rec);
  await loadPaper(rec);
  return rec;
}

/* ================= 选中工具条 ================= */
const selPopup = $("#selPopup");
const selResult = $("#selResult");
let currentSel = { text: "", page: 1 };

document.addEventListener("mouseup", (e) => {
  if (selPopup.contains(e.target) || selResult.contains(e.target)) return;
  setTimeout(() => {
    const s = window.getSelection();
    const text = s ? s.toString().trim() : "";
    if (!text || text.length < 2) { selPopup.hidden = true; return; }
    const tl = s.anchorNode?.parentElement?.closest(".textLayer");
    const page = tl ? parseInt(tl.dataset.page) : (state.record?.lastPage || 1);
    // 记录选区在页内字符流的精确偏移,保证标注只标记"选中的那一次"
    let start = null, end = null;
    if (tl) {
      try {
        const r = s.getRangeAt(0);
        const spans = [...tl.querySelectorAll("span")];
        const spanStart = new Map();
        let acc = 0;
        for (const sp of spans) { spanStart.set(sp, acc); acc += sp.textContent.length; }
        const sSpan = (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer)?.closest?.("span");
        const eSpan = (r.endContainer.nodeType === 3 ? r.endContainer.parentElement : r.endContainer)?.closest?.("span");
        if (spanStart.has(sSpan) && spanStart.has(eSpan)) {
          start = spanStart.get(sSpan) + r.startOffset;
          end = spanStart.get(eSpan) + r.endOffset;
          if (start > end) [start, end] = [end, start];
        }
      } catch (_) {}
    }
    currentSel = { text, page, start, end };
    const r = s.getRangeAt(0).getBoundingClientRect();
    selPopup.hidden = false;
    selPopup.style.left = Math.max(8, r.left + r.width / 2 - 160) + "px";
    selPopup.style.top = Math.max(8, r.top - 44) + "px";
  }, 10);
});
document.addEventListener("mousedown", (e) => {
  if (!selPopup.hidden && !selPopup.contains(e.target)) selPopup.hidden = true;
});

selPopup.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  const { text, page } = currentSel;
  selPopup.hidden = true;
  if (act === "translate") {
    showSelResult(btn, "🌐 翻译中…");
    try {
      const lang = $("#transLang").value;
      const out = await translateText(text, lang);
      showSelResult(btn, "");
      renderMD($("#selResultBody"), out);
    } catch (err) { showSelResult(btn, "❌ " + err.message); }
  } else if (act === "explain") {
    showSelResult(btn, "🤖 AI 阅读中…");
    try {
      const ctx = await getPageText(page);
      const out = await aiChat([
        { role: "system", content: "你是论文阅读助手,用中文讲解。解释中出现的数学式请用 LaTeX($...$ 或 $$...$$)输出。" },
        { role: "user", content: `论文第 ${page} 页上下文:\n${ctx.slice(0, 6000)}\n\n请详细讲解下面这段内容(概念、公式含义、在文中的作用):\n\n"""${text}"""` },
      ]);
      showSelResult(btn, "");
      renderMD($("#selResultBody"), out);
    } catch (err) { showSelResult(btn, "❌ " + err.message); }
  } else if (act === "tochat") {
    // 把选中的文字作为引用带到 AI 对话框
    switchTab("chat");
    const ta = $("#chatInput");
    ta.value = (ta.value ? ta.value + "\n" : "") + `> ${text}\n\n`;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  } else if (act === "hl") {
    addAnnotation(text, page, btn.dataset.c, "", { start: currentSel.start, end: currentSel.end });
    window.getSelection().removeAllRanges();
  } else if (act === "note") {
    $("#noteQuote").textContent = text;
    $("#noteText").value = "";
    $("#modalNote").dataset.color = "";
    $("#modalNote").hidden = false;
  }
});

function showSelResult(anchor, msg) {
  const r = anchor.getBoundingClientRect();
  selResult.hidden = false;
  selResult.style.left = Math.min(window.innerWidth - 440, Math.max(8, r.left)) + "px";
  selResult.style.top = Math.min(window.innerHeight - 200, r.bottom + 8) + "px";
  $("#selResultBody").innerHTML = msg || "";
}
$("#selResultClose").onclick = () => (selResult.hidden = true);

/* AI 讲解/翻译结果卡片:按住标题栏可拖动 */
(() => {
  const el = selResult, head = el.querySelector(".sel-result-head");
  let drag = false, dx = 0, dy = 0;
  head.addEventListener("mousedown", (e) => {
    if (e.target.id === "selResultClose") return;
    drag = true;
    const r = el.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    el.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx)) + "px";
    el.style.top = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dy)) + "px";
  });
  window.addEventListener("mouseup", () => (drag = false));
})();

/* ================= 标注 ================= */
const undoStack = []; // Ctrl+Z 回退

function addAnnotation(text, page, color, note, offsets) {
  const a = {
    id: uid(), page, text, color: color || "#ffe066", note, time: Date.now(),
    start: offsets?.start ?? null, end: offsets?.end ?? null,
  };
  state.record.annotations.push(a);
  undoStack.push({ paperId: state.record.id, annId: a.id, page });
  saveRecords();
  renderNotes();
  applyHighlights(page);
}

/* Ctrl+Z 回退最近一次标注 */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return; // 输入框内不拦截
  if (!undoStack.length) return;
  e.preventDefault();
  const { paperId, annId } = undoStack.pop();
  const rec = state.records.find((r) => r.id === paperId);
  if (!rec) return;
  const ann = rec.annotations.find((x) => x.id === annId);
  rec.annotations = rec.annotations.filter((x) => x.id !== annId);
  saveRecords();
  if (rec === state.record) { renderNotes(); applyHighlights(ann?.page); }
});

/* 高亮:不改动文字层内容(避免重影),按标注记录的精确偏移画半透明色块;
 * 只标记用户当时选中的那一次,不重复标记页内其他相同文字 */
function applyHighlights(page) {
  const tl = document.querySelector(`.textLayer[data-page="${page}"]`);
  if (!tl) return;
  const box = tl.closest(".page-box");
  box.querySelectorAll(".hlrect").forEach((d) => d.remove());
  const notes = state.record?.annotations?.filter((a) => a.page === page) || [];
  if (!notes.length) return;
  const boxRect = box.getBoundingClientRect();
  const spans = [...tl.querySelectorAll("span")];
  // 页内字符流偏移索引(原始文本,不做空白归一)
  const map = [];
  spans.forEach((sp) => {
    for (let i = 0; i < sp.textContent.length; i++) map.push({ node: sp.firstChild, off: i });
  });
  const drawRange = (start, end, color) => {
    const nodes = map.slice(start, end);
    if (!nodes.length) return;
    try {
      const range = document.createRange();
      range.setStart(nodes[0].node, nodes[0].off);
      range.setEnd(nodes[nodes.length - 1].node, nodes[nodes.length - 1].off + 1);
      for (const r of range.getClientRects()) {
        const d = document.createElement("div");
        d.className = "hlrect";
        d.style.left = (r.left - boxRect.left - 1) + "px";
        d.style.top = (r.top - boxRect.top - 1) + "px";
        d.style.width = (r.width + 2) + "px";
        d.style.height = (r.height + 2) + "px";
        d.style.backgroundColor = hexToRgba(color, 0.45);
        box.appendChild(d);
      }
    } catch (_) { /* 忽略异常匹配 */ }
  };
  for (const a of notes) {
    if (a.start != null && a.end != null && a.end <= map.length && a.end > a.start) {
      drawRange(a.start, a.end, a.color);
    } else {
      // 兼容无偏移的旧标注:只匹配第一处,不标记其他相同文字
      let full = "";
      spans.forEach((sp) => (full += sp.textContent));
      const idx = full.indexOf(a.text);
      if (idx !== -1) drawRange(idx, idx + a.text.length, a.color);
    }
  }
}

function renderNotes() {
  const list = $("#notesList");
  list.innerHTML = "";
  const anns = state.record?.annotations || [];
  if (!anns.length) { list.innerHTML = '<p class="hint">暂无标注。选中 PDF 文字后点色块即可高亮,或点 📝 添加笔记。</p>'; return; }
  anns.sort((a, b) => a.page - b.page);
  for (const a of anns) {
    const card = document.createElement("div");
    card.className = "note-card";
    card.style.borderLeftColor = a.color;
    card.style.cursor = "pointer";
    card.title = a.note ? "点击跳转到原文位置;✏️ 可编辑笔记" : "只标了颜色,点击可补充文字";
    card.innerHTML = `<div class="card-btns"><span class="ann-edit" title="补充/编辑笔记">✏️</span><span class="ann-del" title="删除">🗑</span></div>
      <div class="q">“${a.text.slice(0, 120)}${a.text.length > 120 ? "…" : ""}”</div>
      ${a.note ? `<div class="c">${marked.parseInline(a.note)}</div>` : `<div class="c hint">未加笔记,点击卡片可补充文字</div>`}
      <div class="pg">第 ${a.page} 页 · ${new Date(a.time).toLocaleString()} ↗</div>`;
    card.querySelector(".ann-edit").onclick = (e) => { e.stopPropagation(); openNoteEditor(a); };
    card.querySelector(".ann-del").onclick = (e) => {
      e.stopPropagation();
      state.record.annotations = state.record.annotations.filter((x) => x.id !== a.id);
      saveRecords(); renderNotes(); applyHighlights(a.page);
    };
    // 点击整张卡片:纯颜色标注 → 补充文字;已有笔记 → 跳转原文
    card.onclick = () => {
      if (!a.note) { openNoteEditor(a); return; }
      const target = $("#page-" + a.page);
      if (!target) return alert("该页不在当前论文中");
      $("#viewerWrap").scrollTo({ top: Math.max(0, target.offsetTop - 16), behavior: "smooth" });
      renderPage(a.page).then(() => applyHighlights(a.page));
      // 短暂闪烁提示定位
      target.style.outline = "3px solid #2563eb";
      setTimeout(() => (target.style.outline = ""), 1200);
    };
    list.appendChild(card);
  }
}

/* 笔记弹窗 */
/* 笔记弹窗:支持新建(来自选中文字)与编辑已有标注 */
let editingAnn = null;
function openNoteEditor(a) {
  editingAnn = a;
  $("#noteQuote").textContent = a.text;
  $("#noteText").value = a.note || "";
  $("#modalNote").hidden = false;
  $("#noteText").focus();
}
$("#noteSave").onclick = () => {
  const note = $("#noteText").value.trim();
  if (editingAnn) {
    // 编辑已有标注:补充/修改文字
    editingAnn.note = note;
    editingAnn = null;
    saveRecords();
    renderNotes();
    $("#modalNote").hidden = true;
    return;
  }
  const color = $("#modalNote").dataset.color || "#ffe066";
  addAnnotation($("#noteQuote").textContent, currentSel.page, color, note, { start: currentSel.start, end: currentSel.end });
  $("#modalNote").hidden = true;
};
$("#noteCancel").onclick = () => { editingAnn = null; $("#modalNote").hidden = true; };

/* ================= AI 总结(独立标签,自动保存) ================= */
async function genSummary() {
  if (!state.pdf) return alert("请先打开一篇论文");
  const el = $("#sumResult");
  const st = $("#sumStatus");
  st.textContent = "AI 总结中…";
  try {
    let ctx = "";
    const maxPages = Math.min(state.pdf.numPages, 20);
    for (let p = 1; p <= maxPages; p++) ctx += `\n[第${p}页] ${await getPageText(p)}\n`;
    el.innerHTML = "";
    await aiChat([
      { role: "system", content: MATH_RULES },
      { role: "user", content: `请对下面的论文做结构化中文总结,包含:1) 研究问题与动机 2) 核心方法(关键公式用 LaTeX) 3) 实验与结论 4) 局限性。论文内容:\n\n${ctx.slice(0, 60000)}` },
    ], { onDelta: (t) => { el.dataset.buf = el.dataset.buf || ""; renderMD(el, el.dataset.buf += t); } });
    state.record.summary = el.dataset.buf || el.textContent;
    state.record.summaryAt = Date.now();
    saveRecords();
    st.textContent = "总结完成 ✅ 已保存,下次打开自动显示";
  } catch (err) { st.textContent = "❌ " + err.message; }
}
$("#btnSummary").onclick = () => { switchTab("sum"); if (!state.record?.summary) genSummary(); };
$("#btnSumStart").onclick = () => {
  if (!state.pdf) return alert("请先打开一篇论文");
  if (state.record?.summary && !confirm("已有保存的总结,重新生成将覆盖,继续?")) return;
  genSummary();
};

/* ================= 整篇翻译(纯网页重排版) =================
 * 不拷贝 PDF 画面:每页是白色网页,文字按段落块重新排版,
 * 图片直接从 PDF 中提取并以原图位置嵌入,公式用 KaTeX 渲染。
 * 翻译按段落块进行,不要求行数/结构一一对应。
 */

/* 段落块翻译:[[n]] 标记分块;AI 漏标时该块单独重译,绝不因行数问题报错 */
async function translateBlocks(blocks, lang, onProgress) {
  const sys = MATH_RULES + `\n论文片段已用 [[编号]] 标记分段。请把每段翻译成${lang},输出时把对应的 [[编号]] 放在该段译文的开头。不要遗漏、新增或改动编号;段落顺序保持不变。可以自由重新组织段内断行,这是正常排版。
原文中的 **加粗** 是 PDF 中的粗体文字(常见于标题、术语强调),译文中请在对应位置保留 ** 加粗标记。`;
  const input = blocks.map((b, i) => `[[${i}]]\n${b.md || b.text}`).join("\n\n");
  let out = "";
  try {
    out = await aiChat([{ role: "system", content: sys }, { role: "user", content: input }]);
  } catch (err) {
    // 整体失败则逐段翻译
    const res = [];
    for (let i = 0; i < blocks.length; i++) res.push(await translateText(blocks[i].md || blocks[i].text, lang));
    return res;
  }
  const parts = out.split(/\[\[(\d+)\]\]/);
  const map = {};
  for (let i = 1; i + 1 < parts.length + 1; i += 2) if (parts[i] != null) map[parseInt(parts[i])] = (parts[i + 1] || "").trim();
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    if (map[i] && map[i].length) result.push(map[i]);
    else {
      onProgress?.(`段落 ${i + 1} 单独补译…`);
      result.push(await translateText(blocks[i].text, lang));
    }
  }
  return result;
}

/* 从已渲染的文字层提取"行":按垂直位置聚类,再按水平间隙切分双栏;boldMap 记录哪些 span 来自粗体字体 */
function extractLines(tl, boxRect, boldMap) {
  const spans = [...tl.querySelectorAll("span")].filter((s) => s.textContent.trim());
  const items = spans.map((s) => {
    const r = s.getBoundingClientRect();
    return { text: s.textContent, top: r.top - boxRect.top, left: r.left - boxRect.left, right: r.right - boxRect.left, bottom: r.bottom - boxRect.top, bold: boldMap ? !!boldMap.get(s) : false };
  }).filter((i) => i.right > i.left);
  const buckets = [];
  for (const it of items) {
    const cy = (it.top + it.bottom) / 2, h = Math.max(4, it.bottom - it.top);
    let b = buckets.find((x) => Math.abs(x.cy - cy) < h * 0.55);
    if (!b) { b = { cy, items: [] }; buckets.push(b); }
    b.items.push(it);
  }
  buckets.sort((x, y) => x.cy - y.cy);
  const lines = [];
  for (const b of buckets) {
    b.items.sort((x, y) => x.left - y.left);
    let run = null, prevRight = 0;
    for (const it of b.items) {
      if (run && it.left - prevRight < 40) {
        run.text += " " + it.text;
        run.right = it.right;
        // 粗体段落记录:相邻同样粗体的文字合并为一段,不同则分段
        const lastSeg = run.segs[run.segs.length - 1];
        if (lastSeg && lastSeg.b === it.bold) lastSeg.t += " " + it.text;
        else run.segs.push({ t: it.text, b: it.bold });
      } else {
        run = { text: it.text, left: it.left, right: it.right, top: it.top, bottom: it.bottom, segs: [{ t: it.text, b: it.bold }] };
        lines.push(run);
      }
      prevRight = it.right;
    }
  }
  return lines.filter((l) => l.text.trim().length > 1);
}

/* 行 -> 段落块:先按栏聚类,栏内按垂直间隙分段;同时生成带 Markdown 粗体的版本(md 字段) */
function buildBlocks(lines) {
  if (!lines.length) return [];
  // 一行的 Markdown 表示:粗体片段用 ** 包裹
  const lineMd = (l) => {
    if (!l.segs) return l.text;
    return l.segs.map((s) => {
      const t = s.t.trim();
      if (!t) return "";
      return s.b ? `**${t}**` : t;
    }).filter(Boolean).join(" ");
  };
  const cols = []; // 栏:按 left 聚类
  for (const l of lines) {
    let c = cols.find((x) => Math.abs(x.left - l.left) < 60);
    if (!c) { c = { left: l.left, items: [] }; cols.push(c); }
    c.items.push(l);
  }
  cols.sort((a, b) => a.left - b.left);
  const blocks = [];
  for (const c of cols) {
    c.items.sort((a, b) => a.top - b.top);
    let blk = null;
    for (const l of c.items) {
      const h = Math.max(6, l.bottom - l.top);
      if (blk && l.top - blk.bottom < h * 1.7) {
        blk.text += "\n" + l.text;
        blk.md += "\n" + lineMd(l);
        blk.right = Math.max(blk.right, l.right);
        blk.bottom = l.bottom;
        blk.h = Math.max(blk.h, h);
      } else {
        blk = { text: l.text, md: lineMd(l), left: l.left, top: l.top, right: l.right, bottom: l.bottom, h: h };
        blocks.push(blk);
      }
    }
  }
  blocks.sort((a, b) => a.top - b.top);
  return blocks;
}

/* 从 PDF 操作列表提取图片及其页面位置(CTM 跟踪) */
function matMul(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}
async function extractPageImages(page, vp) {
  const OPS = pdfjsLib.OPS;
  let ctm = vp.transform.slice();
  const stack = [];
  const found = [];
  let opList;
  try { opList = await page.getOperatorList(); } catch (_) { return []; }
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = matMul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (args && args[0]) ctm = matMul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
      let obj = null;
      try { obj = page.objs.get(args[0]); } catch (_) {}
      if (obj) {
        const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({
          x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5],
        }));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        found.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), obj });
      }
    } else if (fn === OPS.paintInlineImageXObject) {
      if (args && args[0]) {
        const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({
          x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5],
        }));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        found.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), obj: args[0] });
      }
    }
  }
  const imgs = [];
  for (const f of found) {
    if (f.w < 20 || f.h < 20) continue;                       // 过滤小图标
    if (f.w > vp.width * 0.98 && f.h > vp.height * 0.98) continue; // 整页背景
    const url = imageDataToURL(f.obj);
    if (url) imgs.push({ x: f.x, y: f.y, w: f.w, h: f.h, url });
  }
  return imgs;
}

/* pdf.js 图片对象 -> dataURL(兼容 bitmap / RGBA / RGB / 灰度) */
function imageDataToURL(obj) {
  try {
    const { width, height } = obj;
    if (obj.bitmap && width && height) {
      const c = document.createElement("canvas"); c.width = width; c.height = height;
      c.getContext("2d").drawImage(obj.bitmap, 0, 0);
      return c.toDataURL("image/png");
    }
    const data = obj.data;
    if (!width || !height || !data || !data.length) return null;
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(width, height);
    if (data.length === width * height * 4) id.data.set(data);
    else if (data.length === width * height * 3) {
      for (let i = 0, j = 0; i < width * height; i++) {
        id.data[j++] = data[i * 3]; id.data[j++] = data[i * 3 + 1]; id.data[j++] = data[i * 3 + 2]; id.data[j++] = 255;
      }
    } else if (data.length === width * height) {
      for (let i = 0; i < width * height; i++) {
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = data[i]; id.data[i * 4 + 3] = 255;
      }
    } else return null;
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
  } catch (_) { return null; }
}

let fullTranslating = false; // 整篇翻译进行中
let fullStopReq = false;     // 停止请求(当前页完成后生效)

/* ===== 整篇翻译多版本管理 =====
 * translation.json 结构: { current: 版本id, versions: [{id, createdAt, lang, total, pages}] }
 * state.transStore = 整个版本库;state.fullSaved = 当前激活版本(是 versions 中某项的引用) */
function verLabel(v) {
  const d = new Date(v.createdAt || Date.now());
  const lang = (v.lang || "中文").slice(0, 8);
  const pages = Object.keys(v.pages || {}).length;
  return `${lang} · ${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}(${pages}/${v.total || "?"} 页)`;
}
function normalizeTransStore(store) {
  if (store && Array.isArray(store.versions)) return store;
  // 旧版单版本格式 -> 升级为版本库 V1
  if (store && store.pages && Object.keys(store.pages).length) {
    const id = uid();
    return { current: id, versions: [{ id, createdAt: Date.now(), lang: store.lang || "中文(简体)", total: store.total, pages: store.pages }] };
  }
  return { current: null, versions: [] };
}
function activeVersion() {
  const s = state.transStore;
  return s?.versions?.find((v) => v.id === s.current) || null;
}
function saveTransStore() {
  if (state.transStore && state.record) putTranslation(state.record.id, state.transStore).catch((e) => console.error(e));
}
function renderTransVersions() {
  const sel = $("#transVer"), del = $("#btnVerDel");
  const vs = state.transStore?.versions || [];
  const has = vs.length > 0;
  sel.hidden = !has; del.hidden = !has;
  if (!has) { sel.innerHTML = ""; return; }
  const sorted = [...vs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  sel.innerHTML = sorted.map((v) => `<option value="${v.id}">${verLabel(v)}</option>`).join("");
  sel.value = state.transStore.current || sorted[0].id;
}
/* 把某版本的译文装载到界面 */
function showVersion(v) {
  const out = $("#fullResult");
  out.innerHTML = "";
  const keys = Object.keys(v?.pages || {}).map(Number).sort((a, b) => a - b);
  for (const n of keys) out.insertAdjacentHTML("beforeend", v.pages[n]);
  out.querySelectorAll(".tblock").forEach((d) => d.style.removeProperty("font-size")); // 清除旧版内联小字号
  const done = keys.length;
  $("#pbarFill").style.width = v && v.total ? (done / v.total * 100).toFixed(1) + "%" : "0%";
  return { done, keys };
}
$("#transVer").onchange = async (e) => {
  if (fullTranslating) { alert("翻译进行中,请先停止再切换版本"); renderTransVersions(); return; }
  const v = state.transStore?.versions?.find((x) => x.id === e.target.value);
  if (!v) return;
  state.transStore.current = v.id;
  state.fullSaved = v;
  const { done } = showVersion(v);
  $("#fullStatus").textContent = done ? `已切换到:${verLabel(v)}` : `该版本暂无已翻译页,点「开始整篇翻译」开始`;
  saveTransStore();
  fullBtnLabel();
};
$("#btnVerDel").onclick = async () => {
  if (fullTranslating) return alert("翻译进行中,请先停止再删除版本");
  const s = state.transStore;
  const v = activeVersion();
  if (!s || !v) return;
  const rest = s.versions.length - 1;
  if (!confirm(`删除当前整篇翻译版本?${verLabel(v)}\n${rest ? "删除后自动切换到最近的版本。" : "这是最后一个版本,删除后该论文不再有译文。"}此操作不可恢复。`)) return;
  s.versions = s.versions.filter((x) => x.id !== v.id);
  if (s.versions.length) {
    const nv = [...s.versions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    s.current = nv.id; state.fullSaved = nv;
    const { done } = showVersion(nv);
    $("#fullStatus").textContent = `已删除;切换到 ${verLabel(nv)}(完成 ${done}/${nv.total} 页)`;
  } else {
    s.current = null; state.fullSaved = null;
    showVersion(null);
    $("#fullStatus").textContent = "";
  }
  await putTranslation(state.record.id, s);
  fullBtnLabel(); renderTransVersions();
};

async function startFullTranslate() {
  if (!state.pdf) return alert("请先打开一篇论文");
  if (fullTranslating) return; // 已在翻译中,忽略重复点击
  fullStopReq = false;
  fullTranslating = true;
  fullBtnLabel();
  const st = $("#fullStatus");
  const out = $("#fullResult");
  const lang = $("#transLang").value;
  const scale = Math.max(1.2, state.scale);
  const failed = [];
  let stopped = false;
  // 初始化版本库(兼容旧数据)
  if (!state.transStore) state.transStore = normalizeTransStore(await getTranslation(state.record.id).catch(() => null));
  // 当前版本已完成或不存在 -> 创建新版本(历史版本全部保留)
  const active = activeVersion();
  if (!active || Object.keys(active.pages || {}).length >= active.total) {
    const v = { id: uid(), createdAt: Date.now(), lang, total: state.pdf.numPages, pages: {} };
    state.transStore.versions.unshift(v);
    state.transStore.current = v.id;
    state.fullSaved = v;
    out.innerHTML = ""; // 新版本从零开始显示
    $("#pbarFill").style.width = "0%";
    renderTransVersions();
  } else {
    state.fullSaved = active;
    state.fullSaved.total = state.pdf.numPages;
    if (!out.querySelector(".tpage")) showVersion(active);
    $("#pbarFill").style.width = (Object.keys(active.pages).length / active.total * 100).toFixed(1) + "%";
  }
  try {
    for (let n = 1; n <= state.fullSaved.total; n++) {
      if (fullStopReq) { stopped = true; break; } // 用户请求停止
      if (state.fullSaved.pages[n]) continue;    // 已翻译过,跳过
      st.textContent = `整篇翻译中… 第 ${n}/${state.fullSaved.total} 页(点「停止翻译」可随时中断,进度已保存)`;
      const page = await state.pdf.getPage(n);
      const vp = page.getViewport({ scale });
      // 白色网页页面(不渲染 PDF 画面)
      const box = document.createElement("div");
      box.className = "page-box tpage";
      box.dataset.page = n; // 用于与原文联动滚动
      box.style.width = vp.width + "px";
      box.style.minHeight = vp.height + "px";
      box.innerHTML = `<div class="page-num">${n} / ${state.fullSaved.total}</div>`;
      out.appendChild(box);
      try {
        // 1) 临时文字层:只用来取行位置,用完删除
        const tl = document.createElement("div");
        tl.className = "textLayer";
        tl.style.setProperty("--scale-factor", scale);
        box.appendChild(tl);
        const tc = await page.getTextContent();
        const textDivs = [];
        pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs });
        await new Promise((r) => setTimeout(r, 80));
        // 粗体识别:文本项携带 fontName,经 commonObjs 解析字体名判断粗体,标记到对应 span
        const boldMap = new Map();
        try {
          if (textDivs.length === tc.items.length) {
            const fontCache = {};
            for (let i = 0; i < tc.items.length; i++) {
              const fn = tc.items[i].fontName;
              if (!fn) continue;
              if (fontCache[fn] === undefined) {
                let b = false;
                try {
                  const font = page.commonObjs.get(fn);
                  const nm = `${font?.name || ""} ${font?.fallbackName || ""} ${font?.loadedName || ""}`;
                  b = /bold|black|heavy|semib|demi|medi/i.test(nm);
                } catch (_) {}
                fontCache[fn] = b;
              }
              if (fontCache[fn]) boldMap.set(textDivs[i], true);
            }
          }
        } catch (_) {}
        const lines = extractLines(tl, box.getBoundingClientRect(), boldMap);
        tl.remove();
        const blocks = buildBlocks(lines);
        // 2) 离屏预渲染一次:pdf.js 只有在渲染时才会解码内嵌位图,否则 objs 为空导致图片丢失
        try {
          const ovp = page.getViewport({ scale: 0.5 });
          const oc = document.createElement("canvas");
          oc.width = Math.ceil(ovp.width); oc.height = Math.ceil(ovp.height);
          await page.render({ canvasContext: oc.getContext("2d"), viewport: ovp }).promise;
        } catch (_) {}
        const imgs = await extractPageImages(page, vp);
        // 3) 段落块翻译
        let trans = [];
        if (blocks.length) {
          trans = await translateBlocks(blocks, lang, (m) => (st.textContent = `第 ${n} 页:${m}`));
        }
        // 4) 流式文档排版:按栏聚类确定阅读顺序(左栏优先、栏内自上而下),逐块下排,绝不重叠
        const items = [];
        blocks.forEach((b, i) => items.push({ type: "text", top: b.top, left: b.left, right: b.right, h: b.h, text: trans[i] }));
        imgs.forEach((im) => items.push({ type: "img", top: im.y, left: im.x, right: im.x + im.w, im }));
        const cols = [];
        for (const it of items) {
          let c = cols.find((x) => Math.abs(x.left - it.left) < 120);
          if (!c) { c = { left: it.left, items: [] }; cols.push(c); }
          c.items.push(it);
        }
        cols.sort((a, b) => a.left - b.left);
        const ordered = [];
        for (const c of cols) {
          c.items.sort((a, b) => a.top - b.top);
          ordered.push(...c.items);
        }
        const head = document.createElement("div");
        head.className = "tpage-head";
        head.textContent = `第 ${n} 页`;
        box.appendChild(head);
        for (const it of ordered) {
          if (it.type === "img") {
            const im = document.createElement("img");
            im.src = it.im.url;
            im.style.width = Math.min(it.im.w, vp.width * 0.9) + "px";
            box.appendChild(im);
          } else {
            const div = document.createElement("div");
            div.className = "tblock md-body";
            renderMD(div, it.text || "");
            box.appendChild(div);
          }
        }
        // 5) 保存本页进度(整个版本库一起保存)
        state.fullSaved.pages[n] = box.outerHTML;
        await putTranslation(state.record.id, state.transStore);
      } catch (err) {
        // 单页失败:就地显示错误,继续后面页
        failed.push(n);
        const e = document.createElement("div");
        e.className = "page-err";
        e.textContent = `❌ 第 ${n} 页翻译失败:${err.message}(下次重试可再点「继续翻译」)`;
        box.appendChild(e);
      }
      { const pane = $("#tab-full"), pr = pane.getBoundingClientRect(), rr = out.getBoundingClientRect(); pane.scrollTop = Math.max(0, pane.scrollTop + rr.top - pr.top - 8); }
      const done = Object.keys(state.fullSaved.pages).length;
      $("#pbarFill").style.width = (done / state.fullSaved.total * 100).toFixed(1) + "%";
    }
    const done = Object.keys(state.fullSaved.pages).length;
    const total = state.fullSaved.total;
    if (stopped) {
      let next = total;
      for (let i = 1; i <= total; i++) if (!state.fullSaved.pages[i]) { next = i; break; }
      st.textContent = `已停止 ⏸ 完成 ${done}/${total} 页,点「▶ 继续翻译」将从第 ${next} 页接着翻`;
    } else if (failed.length) {
      st.textContent = `翻译完成,${failed.length} 页失败(第 ${failed.join("、")} 页),可重试 ⚠️`;
    } else {
      st.textContent = "整篇翻译完成 ✅ 已保存,下次打开自动显示";
      $("#pbarFill").style.width = "100%";
    }
  } catch (err) {
    st.textContent = "❌ " + err.message;
  } finally {
    fullTranslating = false;
    fullStopReq = false;
    fullBtnLabel();
  }
}

/* 按钮点击:翻译中=请求停止;空闲=开始/继续(当前版本完成时自动存为新版本) */
$("#btnFullStart").onclick = () => {
  if (fullTranslating) {
    fullStopReq = true;
    $("#fullStatus").textContent = "停止中…(当前页翻译完成后停下,已翻页均已保存)";
    return;
  }
  startFullTranslate();
};
$("#btnTranslateAll").onclick = () => { switchTab("full"); $("#btnFullStart").click(); };

/* 根据进度刷新主按钮:翻译中=停止 / 当前版本未完成=继续 / 已完成或无版本=开始(新版本) */
function fullBtnLabel() {
  try {
    const btn = $("#btnFullStart");
    if (!btn) return;
    if (fullTranslating) { btn.textContent = "⏹ 停止翻译"; return; }
    const v = state.fullSaved;
    const pages = v?.pages || {};
    const total = v?.total || (state.pdf ? state.pdf.numPages : 0);
    const done = Object.keys(pages).length;
    if (v && done > 0 && done < total) {
      let next = total;
      for (let i = 1; i <= total; i++) if (!pages[i]) { next = i; break; }
      btn.textContent = "▶ 继续翻译(从第 " + next + " 页)";
    } else if (v && done >= total && total > 0) {
      btn.textContent = "🆕 重新翻译(存为新版本)";
    } else {
      btn.textContent = "开始整篇翻译(保留原版式与图片)";
    }
  } catch (_) { /* 界面元素缺失时静默 */ }
}

/* 整篇译文字号调节(A− / A+,默认 18px) */
(() => {
  let fs = Math.min(32, Math.max(12, parseInt(localStorage.getItem("pr.fullFs")) || 14));
  const apply = () => {
    $("#fullResult").style.setProperty("font-size", fs + "px", "important");
    $("#fsVal").textContent = fs + "px";
    localStorage.setItem("pr.fullFs", fs);
  };
  const step = (d) => { fs = Math.min(32, Math.max(12, fs + d)); apply(); };
  $("#fsMinus").onclick = () => step(-2);
  $("#fsPlus").onclick = () => step(2);
  apply();
})();

/* 整篇工具栏显隐:滚动/鼠标靠近顶部时浮现,静止 1.6s 后淡出(与 PDF 翻页器同款) */
(() => {
  const pane = $("#tab-full");
  const bar = pane.querySelector(".trans-ctl");
  if (!bar) return;
  let timer = null;
  const show = () => {
    bar.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!fullTranslating) bar.classList.remove("show"); // 翻译进行中保持可见
    }, 1600);
  };
  pane.addEventListener("scroll", show, { passive: true });
  // 鼠标移到面板顶部区域时浮现
  pane.addEventListener("mousemove", (e) => {
    const pr = pane.getBoundingClientRect();
    if (e.clientY - pr.top < 56) show();
  });
  bar.addEventListener("mouseenter", () => clearTimeout(timer));
  bar.addEventListener("mouseleave", show);
  // 首次进入该标签页时短暂显示,引导发现按钮
  $(".tabs")?.querySelector('[data-tab="full"]')?.addEventListener("click", () => show());
})();

/* 整篇翻译视图 ↔ 原文视图 双向联动滚动 */
(() => {
  const pane = $("#tab-full");
  const wrap = $("#viewerWrap");
  let lock = false; // 防止两方向程序化滚动互相触发
  const setLater = (fn) => { lock = true; fn(); setTimeout(() => (lock = false), 120); };

  // 译文 → 原文
  pane.addEventListener("scroll", () => {
    if (lock || !pane.classList.contains("active")) return;
    clearTimeout(pane._t);
    pane._t = setTimeout(() => {
      const pages = [...pane.querySelectorAll(".tpage")];
      if (!pages.length || !state.pdf) return;
      const paneRect = pane.getBoundingClientRect();
      let target = null, frac = 0;
      for (const p of pages) {
        const r = p.getBoundingClientRect();
        if (r.bottom > paneRect.top + 24) {
          target = p;
          frac = Math.min(1, Math.max(0, (paneRect.top + 24 - r.top) / Math.max(1, r.height)));
          break;
        }
      }
      if (!target) return;
      const vPage = $("#page-" + target.dataset.page);
      if (!vPage) return;
      setLater(() => { wrap.scrollTop = Math.max(0, vPage.offsetTop + frac * vPage.offsetHeight - 24); });
      renderPage(parseInt(target.dataset.page));
    }, 60);
  });

  // 原文 → 译文
  wrap.addEventListener("scroll", () => {
    if (lock) return;
    clearTimeout(wrap._t);
    wrap._t = setTimeout(() => {
      const boxes = [...$$("#viewer .page-box")];
      if (!boxes.length || !pane.querySelector(".tpage")) return;
      const wrapRect = wrap.getBoundingClientRect();
      let target = null, frac = 0;
      for (const b of boxes) {
        const r = b.getBoundingClientRect();
        if (r.bottom > wrapRect.top + 24) {
          target = b;
          frac = Math.min(1, Math.max(0, (wrapRect.top + 24 - r.top) / Math.max(1, r.height)));
          break;
        }
      }
      if (!target) return;
      const n = parseInt(target.id.slice(5));
      const tp = pane.querySelector(`.tpage[data-page="${n}"]`);
      if (!tp) return;
      const paneRect = pane.getBoundingClientRect();
      const r = tp.getBoundingClientRect();
      setLater(() => { pane.scrollTop = Math.max(0, pane.scrollTop + (r.top + frac * r.height) - (paneRect.top + 24)); });
    }, 60);
  });
})();

$("#btnTransPage").onclick = async () => {
  if (!state.pdf) return alert("请先打开一篇论文");
  const p = state.record?.lastPage || 1;
  const st = $("#transStatus");
  st.textContent = `翻译第 ${p} 页…`;
  try {
    const src = await getPageText(p);
    const out = await translateText(src, $("#transLang").value);
    const el = $("#transResult");
    el.innerHTML = `<h4 style="color:#2563eb">第 ${p} 页译文</h4>`;
    const body = document.createElement("div");
    el.appendChild(body);
    renderMD(body, out);
    st.textContent = "完成 ✅";
  } catch (err) { st.textContent = "❌ " + err.message; }
};

/* ================= AI 对话(历史自动保存,可单条/全部删除) ================= */
function renderChat() {
  const log = $("#chatLog");
  log.innerHTML = "";
  for (let i = 0; i < state.chat.length; i++) {
    const m = state.chat[i];
    const d = document.createElement("div");
    d.className = "msg " + m.role;
    const del = document.createElement("button");
    del.className = "msg-del";
    del.title = "删除这条";
    del.textContent = "✕";
    const idx = i;
    del.onclick = () => { state.chat.splice(idx, 1); saveChat(); renderChat(); };
    const body = document.createElement("div");
    body.className = "msg-body";
    if (m.role === "user") body.textContent = m.content;
    else renderMD(body, m.content || "…");
    d.append(del, body);
    log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}

/* ---- 会话管理:打开 HTML 即新会话;历史会话保存、可查看、可删除 ---- */
function sessions() {
  if (!state.record) return [];
  state.record.sessions = state.record.sessions || [];
  return state.record.sessions;
}
function renderSessions() {
  const list = $("#sessionsList");
  const arr = sessions();
  if (!arr.length) { list.innerHTML = '<div class="hint">暂无历史会话</div>'; return; }
  list.innerHTML = arr.map((s) => `<div class="sess-item${s === state.activeSession ? " active" : ""}" data-id="${s.id}">
      <span class="t">${(s.title || "会话").replace(/</g, "&lt;")}</span>
      <span class="tm">${new Date(s.createdAt).toLocaleString()}</span>
      <button class="sd" title="删除会话">🗑</button></div>`).join("");
  list.querySelectorAll(".sess-item").forEach((el) => {
    el.onclick = (e) => {
      const s = sessions().find((x) => x.id === el.dataset.id);
      if (!s) return;
      if (e.target.classList.contains("sd")) {
        e.stopPropagation();
        if (!confirm("删除该会话?")) return;
        state.record.sessions = state.record.sessions.filter((x) => x.id !== s.id);
        if (state.activeSession === s) { state.activeSession = null; state.chat = []; renderChat(); }
        saveRecords();
        renderSessions();
        return;
      }
      state.activeSession = s;
      state.chat = s.messages || [];
      renderChat();
      renderSessions();
    };
  });
}
$("#btnSessionsToggle").onclick = () => {
  const l = $("#sessionsList");
  l.hidden = !l.hidden;
  renderSessions();
};
$("#btnNewSession").onclick = () => {
  state.activeSession = null;
  state.chat = [];
  renderChat();
  renderSessions();
};

function saveChat() {
  if (!state.record || !state.activeSession) return; // 新会话在首条消息发送时才建立
  state.activeSession.messages = state.chat.slice(-200);
  state.record.sessions = state.record.sessions.slice(0, 30);
  saveRecords();
}
async function sendChat() {
  const input = $("#chatInput");
  const q = input.value.trim();
  if (!q) return;
  if (!state.pdf) return alert("请先打开一篇论文");
  input.value = "";
  const userMsg = { role: "user", content: q };
  const aiMsg = { role: "assistant", content: "" };
  state.chat.push(userMsg, aiMsg);
  // 首条消息时建立新会话并保存到历史
  if (!state.activeSession && state.record) {
    state.activeSession = { id: uid(), title: q.slice(0, 24), createdAt: Date.now(), messages: state.chat };
    sessions().unshift(state.activeSession);
  }
  saveChat();
  renderSessions();
  renderChat();
  const log = $("#chatLog");
  const body = () => log.lastElementChild?.querySelector(".msg-body");
  body().textContent = "…";
  try {
    const page = state.record?.lastPage || 1;
    // 按勾选决定是否附带上下文:都不勾则只发送用户输入
    let content = q;
    if ($("#ctxAll").checked) {
      let ctx = "";
      const maxPages = Math.min(state.pdf.numPages, 20);
      for (let p = 1; p <= maxPages; p++) ctx += `\n[第${p}页] ${await getPageText(p)}\n`;
      content = `论文《${state.record.title}》全文内容:\n${ctx.slice(0, 60000)}\n\n我的问题:${q}`;
    } else if ($("#ctxPage").checked) {
      content = `论文《${state.record.title}》第${page}页内容:\n${(await getPageText(page)).slice(0, 6000)}\n\n我的问题:${q}`;
    }
    const history = state.chat.slice(0, -2).slice(-10); // 之前的对话(不含本轮)
    // 多模态:附件图片作为 vision 消息内容一并发送
    let userContent = content;
    if (state.attach?.some((a) => a.type === "image")) {
      userContent = [{ type: "text", text: content }];
      for (const a of state.attach) if (a.type === "image") {
        userContent.push({ type: "image_url", image_url: { url: a.url } });
      }
    }
    // 对话独立模型(未选则跟随全局)
    const override = state.chatModel
      ? { providerId: state.chatModel.split("::")[0], model: state.chatModel.split("::").slice(1).join("::") }
      : undefined;
    aiMsg.content = await aiChat(
      [{ role: "system", content: MATH_RULES }, ...history, { role: "user", content: userContent }],
      {
        override,
        onDelta: (t) => {
          aiMsg.content += t;
          const b = body();
          if (b) renderMD(b, aiMsg.content);
          log.scrollTop = log.scrollHeight;
        },
      }
    );
    state.attach = [];
    renderAttach();
  } catch (err) {
    aiMsg.content = "❌ " + err.message;
  }
  saveChat();
  renderChat();
}
$("#btnChatSend").onclick = sendChat;
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$("#btnChatClear").onclick = () => {
  if (!state.chat.length) return;
  if (!confirm("清空本篇论文的全部对话历史?")) return;
  state.chat = [];
  saveChat();
  renderChat();
};

/* ================= 多模态附件:图片直传 / 视频抽帧 / 语音转文字 ================= */
function renderAttach() {
  const bar = $("#attachBar");
  bar.hidden = !state.attach?.length;
  bar.innerHTML = "";
  (state.attach || []).forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.innerHTML = a.type === "image" ? `<img src="${a.url}"><span>${a.name || "图片"}</span>` : `<span>🎙 ${a.name || "语音"}</span>`;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.onclick = () => { state.attach.splice(i, 1); renderAttach(); };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
}
/* 视频 → 均匀抽取最多 4 帧作为图片附件 */
function videoToFrames(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = async () => {
      const dur = v.duration || 1;
      const n = Math.min(4, Math.max(1, Math.ceil(dur / 10)));
      const W = 480;
      const frames = [];
      for (let i = 0; i < n; i++) {
        const t = Math.min((dur * (i + 0.5)) / n, Math.max(0, dur - 0.1));
        await new Promise((r) => { v.onseeked = r; try { v.currentTime = t; } catch (_) {} setTimeout(r, 2500); });
        try {
          const c = document.createElement("canvas");
          const sc = W / (v.videoWidth || W);
          c.width = W; c.height = Math.round((v.videoHeight || 300) * sc);
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          frames.push(c.toDataURL("image/jpeg", 0.72));
        } catch (_) {}
      }
      resolve(frames);
    };
    v.onerror = () => resolve([]);
  });
}
/* 语音 → 文字(经本地服务器转发到 /audio/transcriptions) */
async function transcribeAudio(blob, filename) {
  const r = await fetch(`/api/audio?filename=${encodeURIComponent(filename || "audio.webm")}&model=whisper-1`, { method: "POST", body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `语音转写失败 ${r.status}(需平台支持 /audio/transcriptions,如 whisper-1)`);
  return j.text;
}
/* 统一媒体文件处理:图片直传 / 视频抽帧 / 语音转文字(供选择、粘贴、拖拽共用) */
async function handleMediaFiles(files) {
  for (const f of files) {
    try {
      if (f.type.startsWith("image/")) {
        const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
        state.attach.push({ type: "image", url, name: f.name || "粘贴图片" });
      } else if (f.type.startsWith("video/")) {
        const frames = await videoToFrames(f);
        if (!frames.length) alert("无法读取视频 " + (f.name || ""));
        frames.forEach((url, k) => state.attach.push({ type: "image", url, name: `${f.name || "视频"} 帧${k + 1}` }));
      } else if (f.type.startsWith("audio/")) {
        const text = await transcribeAudio(f, f.name);
        const ta = $("#chatInput");
        ta.value += (ta.value ? "\n" : "") + text;
      } else alert("不支持的文件类型:" + (f.name || f.type));
    } catch (err) { alert("处理 " + (f.name || "文件") + " 失败:" + err.message); }
  }
  renderAttach();
}
$("#btnAttach").onclick = () => $("#attachInput").click();
$("#attachInput").onchange = async (e) => {
  await handleMediaFiles([...e.target.files]);
  e.target.value = "";
};
/* 粘贴:截图/复制的媒体文件直接进入对话框 */
$("#chatInput").addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^(image|video|audio)\//.test(f.type));
  if (!files.length) return; // 普通文本粘贴不拦截
  e.preventDefault();
  await handleMediaFiles(files);
});
/* 拖拽:图片/视频/语音拖入对话区即作为附件(PDF 仍走全局拖入文献库) */
(() => {
  const pane = $("#tab-chat");
  const isMedia = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  pane.addEventListener("dragover", (e) => { if (isMedia(e)) { e.preventDefault(); pane.classList.add("dropzone"); } });
  pane.addEventListener("dragleave", () => pane.classList.remove("dropzone"));
  pane.addEventListener("drop", async (e) => {
    pane.classList.remove("dropzone");
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^(image|video|audio)\//.test(f.type));
    if (!files.length) return; // 非媒体(如 PDF)交给全局处理器
    e.preventDefault();
    e.stopPropagation();
    await handleMediaFiles(files);
  });
})();
/* 麦克风录音 → 停止后自动转文字 */
let micRec = null, micChunks = [];
$("#btnMic").onclick = async () => {
  if (micRec) { micRec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micChunks = [];
    micRec = new MediaRecorder(stream);
    $("#btnMic").classList.add("rec");
    $("#btnMic").title = "录音中…点击结束";
    micRec.ondataavailable = (ev) => micChunks.push(ev.data);
    micRec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $("#btnMic").classList.remove("rec");
      $("#btnMic").title = "点击开始录音";
      const blob = new Blob(micChunks, { type: "audio/webm" });
      micRec = null;
      const ta = $("#chatInput");
      const old = ta.placeholder;
      ta.placeholder = "语音转写中…";
      try {
        const text = await transcribeAudio(blob, "audio.webm");
        ta.value += (ta.value ? "\n" : "") + text;
      } catch (err) { alert(err.message); }
      ta.placeholder = old;
    };
    micRec.start();
  } catch (err) { alert("无法访问麦克风:" + err.message); }
};

/* ================= 面板切换 ================= */
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}
$$(".tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));

/* ================= 文献库树 ================= */
function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  const byFolder = {};
  for (const r of state.records) (byFolder[r.folder] = byFolder[r.folder] || []).push(r);
  for (const folder of Object.keys(byFolder).sort()) {
    const f = document.createElement("div");
    f.className = "folder";
    const head = document.createElement("div");
    head.className = "folder-head";
    head.innerHTML = `<span>📂</span><span>${folder}</span><span class="cnt">(${byFolder[folder].length})</span>`;
    const ch = document.createElement("div");
    ch.className = "folder-children";
    for (const r of byFolder[folder].sort((a, b) => (b.lastRead || b.addedAt) - (a.lastRead || a.addedAt))) {
      const it = document.createElement("div");
      it.className = "paper-item" + (r.id === state.record?.id ? " active" : "");
      it.textContent = r.title;
      it.title = r.name;
      it.onclick = () => loadPaper(r);
      ch.appendChild(it);
    }
    head.onclick = () => (ch.style.display = ch.style.display === "none" ? "" : "none");
    f.append(head, ch);
    tree.appendChild(f);
  }
  if (!state.records.length) tree.innerHTML = '<p class="hint">暂无论文,点击上方「打开 PDF」或拖入文件。</p>';
}

/* 移动到目录 */
$("#btnNewFolder").onclick = () => {
  if (!state.record) return alert("请先在文献库中打开一篇论文");
  const folder = prompt("目录路径(用 / 分层,如:深度学习/Transformer):", state.record.folder);
  if (folder === null) return;
  state.record.folder = folder.trim() || "未分类";
  saveRecords(); renderTree();
};

/* 导出论文:直接下载原始 PDF,文件名与论文名一致 */
$("#btnExportPaper").onclick = () => {
  if (!state.record) return alert("请先打开一篇论文");
  const name = (state.record.title || state.record.name || state.record.id).replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_");
  const a = document.createElement("a");
  a.href = `/api/papers/${encodeURIComponent(state.record.id)}/pdf`;
  a.download = name + ".pdf";
  document.body.appendChild(a); a.click(); a.remove();
};

/* 删除论文 */
$("#btnDeletePaper").onclick = async () => {
  if (!state.record) return alert("请先打开一篇论文");
  if (!confirm(`删除《${state.record.title}》及其标注、翻译与关联?`)) return;
  await delPaperFiles(state.record.id); // 一并删除 PDF 与翻译存档
  state.records = state.records.filter((r) => r.id !== state.record.id);
  state.records.forEach((r) => (r.relations = r.relations.filter((id) => id !== state.record.id)));
  state.record = null; state.pdf = null;
  viewer.innerHTML = "";
  $("#empty").style.display = "flex";
  saveRecords(); renderTree(); renderNotes();
};

/* 添加关联:仅限同一文件夹内的论文(跨文件夹不提供关联) */
$("#btnRelate").onclick = () => {
  if (!state.record) return alert("请先打开一篇论文");
  pruneCrossFolderRelations();
  const others = state.records.filter((r) => r.id !== state.record.id && r.folder === state.record.folder);
  if (!others.length) return alert(`文件夹「${state.record.folder}」内没有其他论文。关联仅在相同文件夹内建立,请先把相关论文移动到同一目录。`);
  const msg = others.map((r, i) => `${i + 1}. 《${r.title}》`).join("\n");
  const inp = prompt(`与《${state.record.title}》建立关联(同文件夹「${state.record.folder}」内)。输入编号,多个用逗号分隔:\n${msg}`);
  if (!inp) return;
  const existing = new Set(state.record.relations);
  for (const n of inp.split(/[,,\s]+/)) {
    const r = others[parseInt(n) - 1];
    if (r) { existing.add(r.id); r.relations = [...new Set([...r.relations, state.record.id])]; }
  }
  state.record.relations = [...existing];
  saveRecords(); renderTree();
  alert("关联已保存(双向,仅同文件夹)。点右上「🔗 关系图」查看。");
};

/* 修剪跨文件夹的历史关联 */
function pruneCrossFolderRelations() {
  for (const r of state.records) {
    r.relations = (r.relations || []).filter((id) => {
      const o = state.records.find((x) => x.id === id);
      return o && o.folder === r.folder;
    });
  }
}

/* ================= 关系图(单文件夹内) ================= */
function drawGraph(folder) {
  const svg = $("#graphSvg");
  const W = svg.clientWidth || 900, H = svg.clientHeight || 450;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  pruneCrossFolderRelations();
  const recs = state.records.filter((r) => r.folder === folder);
  let html = `<text x="12" y="20" font-size="12" fill="#6b7280">文件夹「${folder}」共 ${recs.length} 篇;仅展示同文件夹内关联</text>`;
  const pos = {};
  recs.forEach((r, i) => {
    const a = (i / Math.max(1, recs.length)) * Math.PI * 2 - Math.PI / 2;
    pos[r.id] = { x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.36, y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.36 };
  });
  for (const r of recs) {
    for (const id of r.relations) {
      if (pos[id] && pos[r.id] && r.id < id) { // r.id<id 避免双向重复画线
        html += `<line x1="${pos[r.id].x}" y1="${pos[r.id].y}" x2="${pos[id].x}" y2="${pos[id].y}" stroke="#93c5fd" stroke-width="1.5"/>`;
      }
    }
  }
  for (const r of recs) {
    const p = pos[r.id];
    const deg = r.relations.length;
    html += `<g class="gnode" data-id="${r.id}">
      <circle cx="${p.x}" cy="${p.y}" r="${14 + deg * 2}" fill="${r.id === state.record?.id ? "#2563eb" : "#60a5fa"}" opacity=".9"/>
      <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" fill="#fff">${deg || ""}</text>
      <text x="${p.x}" y="${p.y + 14 + deg * 2 + 14}" text-anchor="middle" font-size="11" fill="#374151">${r.title.slice(0, 18)}</text>
    </g>`;
  }
  svg.innerHTML = html || `<text x="12" y="40" font-size="13" fill="#9ca3af">该文件夹内暂无论文</text>`;
  svg.querySelectorAll(".gnode").forEach((g) => {
    g.style.cursor = "pointer";
    g.onclick = () => {
      const rec = state.records.find((r) => r.id === g.dataset.id);
      $("#modalGraph").hidden = true;
      if (rec) loadPaper(rec);
    };
  });
}

$("#btnGraph").onclick = () => {
  pruneCrossFolderRelations();
  saveRecords();
  const folders = [...new Set(state.records.map((r) => r.folder))].sort();
  if (!folders.length) return alert("文献库为空,请先打开论文");
  const sel = $("#graphFolder");
  sel.innerHTML = folders.map((f) => `<option value="${f}">${f}</option>`).join("");
  sel.value = state.record?.folder || folders[0];
  $("#modalGraph").hidden = false;
  requestAnimationFrame(() => drawGraph(sel.value));
};
$("#graphFolder").onchange = (e) => drawGraph(e.target.value);
$("#graphClose").onclick = () => ($("#modalGraph").hidden = true);
$("#modalGraph").addEventListener("click", (e) => { if (e.target.id === "modalGraph") $("#modalGraph").hidden = true; });

/* ================= 设置弹窗(多平台多模型) ================= */
let provDraft = []; // 编辑中的平台列表
let mmProv = null;  // 正在管理模型的平台(草稿)

function renderProvList() {
  const list = $("#provList");
  list.innerHTML = "";
  provDraft.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "prov-row";
    row.innerHTML = `
      <div class="prov-head">
        <input class="pv-name" placeholder="平台名称" value="${(p.name || "").replace(/"/g, "&quot;")}" style="max-width:110px">
        <input class="pv-url" placeholder="Base URL,如 https://api.openai.com/v1 或 http://内网:8000/v1" value="${(p.baseUrl || "").replace(/"/g, "&quot;")}">
        <button class="pv-test">测试</button>
        <button class="pv-del" title="删除平台">🗑</button>
      </div>
      <label>API Key<input class="pv-key" type="password" placeholder="sk-…(内部服务可留空)" value="${(p.apiKey || "").replace(/"/g, "&quot;")}"></label>
      <button class="pv-models-btn">🧩 管理模型(${p.models.length})</button>
      <div class="pv-msg hint"></div>`;
    row.querySelector(".pv-del").onclick = () => { provDraft.splice(i, 1); renderProvList(); };
    row.querySelector(".pv-models-btn").onclick = () => { collectProvRow(row, i); openModelsMgr(provDraft[i]); };
    row.querySelector(".pv-test").onclick = async () => {
      collectProvRow(row, i);
      const msg = row.querySelector(".pv-msg");
      msg.textContent = "测试中…";
      try {
        const r = await aiChat([{ role: "user", content: "回复 OK" }], {
          override: { providerId: p.id, model: p.models?.[0]?.id },
          direct: { baseUrl: p.baseUrl, apiKey: p.apiKey },
        });
        msg.textContent = "✅ 连接成功:" + String(r).slice(0, 40);
        msg.className = "pv-msg ok";
      } catch (err) {
        msg.textContent = "❌ " + err.message;
        msg.className = "pv-msg bad";
      }
    };
    list.appendChild(row);
  });
}
function collectProvRow(row, i) {
  provDraft[i].name = row.querySelector(".pv-name").value.trim() || `平台${i + 1}`;
  provDraft[i].baseUrl = row.querySelector(".pv-url").value.trim();
  provDraft[i].apiKey = row.querySelector(".pv-key").value.trim();
}

/* ---- 模型管理弹窗:模型 ID 与显示名分开 ---- */
function openModelsMgr(p) {
  mmProv = p;
  $("#mmProvName").textContent = "· " + (p.name || p.baseUrl);
  $("#mmMsg").textContent = "";
  $("#modalModels").hidden = false;
  renderMM();
}
function renderMM() {
  const list = $("#mmList");
  list.innerHTML = "";
  mmProv.models.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "mm-row";
    row.innerHTML = `<input class="mm-id" placeholder="模型 ID(接口名),如 gpt-4o-mini" value="${(m.id || "").replace(/"/g, "&quot;")}">
      <input class="mm-name" placeholder="显示名(可选),如 快速版" value="${(m.name || "").replace(/"/g, "&quot;")}">
      <button title="移除">🗑</button>`;
    row.querySelector("button").onclick = () => { mmProv.models.splice(i, 1); renderMM(); };
    list.appendChild(row);
  });
  if (!mmProv.models.length) list.innerHTML = '<p class="hint">暂无模型,点下方「＋ 添加模型」或「拉取平台模型」</p>';
}
function collectMM() {
  mmProv.models = [...$$("#mmList .mm-row")].map((row) => ({
    id: row.querySelector(".mm-id").value.trim(),
    name: row.querySelector(".mm-name").value.trim(),
  })).filter((m) => m.id);
}
$("#mmAdd").onclick = () => { collectMM(); mmProv.models.push({ id: "", name: "" }); renderMM(); };
$("#mmPull").onclick = async () => {
  collectMM();
  const msg = $("#mmMsg");
  if (!mmProv.baseUrl) { msg.textContent = "❌ 请先在平台设置中填写 Base URL"; return; }
  msg.textContent = "拉取中…";
  try {
    const r = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: mmProv.baseUrl, apiKey: mmProv.apiKey }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
    const data = await r.json();
    const ids = (data.data || data.models || []).map((m) => m.id || m.name || m).filter(Boolean);
    if (!ids.length) throw new Error("接口未返回模型");
    const set = new Set(mmProv.models.map((m) => m.id));
    ids.forEach((id) => { if (!set.has(id)) mmProv.models.push({ id, name: "" }); });
    renderMM();
    msg.textContent = `✅ 拉取到 ${ids.length} 个模型,已合并`;
  } catch (err) {
    msg.textContent = "❌ 拉取失败:" + err.message + "(可手动添加)";
  }
};
$("#mmDone").onclick = () => {
  collectMM();
  $("#modalModels").hidden = true;
  renderProvList(); // 刷新各平台的模型数量按钮
};

$("#btnConfig").onclick = () => {
  provDraft = JSON.parse(JSON.stringify(cfg.providers));
  $("#cfgLang").value = cfg.lang;
  $("#cfgMsg").textContent = "";
  $("#modalConfig").hidden = false;
  renderProvList();
};
$("#provAdd").onclick = () => {
  provDraft.push({ id: uid(), name: `平台${provDraft.length + 1}`, baseUrl: "", apiKey: "", models: [{ id: "gpt-4o-mini", name: "" }] });
  renderProvList();
};
$("#cfgCancel").onclick = () => ($("#modalConfig").hidden = true);
$("#cfgSave").onclick = () => {
  $$("#provList .prov-row").forEach((row, i) => collectProvRow(row, i));
  provDraft = provDraft.filter((p) => p.baseUrl && p.models.some((m) => m.id));
  if (!provDraft.length) return alert("至少配置一个平台(Base URL 和模型)");
  const active = provDraft.find((p) => p.id === cfg.activeProviderId && p.models.some((m) => m.id === cfg.activeModel));
  cfg.providers = provDraft;
  if (!active) { cfg.activeProviderId = provDraft[0].id; cfg.activeModel = provDraft[0].models[0].id; }
  cfg.lang = $("#cfgLang").value.trim() || "中文(简体)";
  const sel = $("#transLang");
  if (![...sel.options].some((o) => o.value === cfg.lang)) sel.add(new Option(cfg.lang, cfg.lang));
  sel.value = cfg.lang;
  saveCfg();
  rebuildModelSelects();
  $("#modalConfig").hidden = true;
};

/* 顶栏全局模型 / 对话独立模型 下拉(显示名与模型 ID 分开展示) */
function rebuildModelSelects() {
  const opts = [];
  for (const p of cfg.providers) for (const m of p.models) opts.push({ pid: p.id, name: p.name, m });
  const label = (o) => `${o.name} · ${o.m.name || o.m.id}`;
  $("#modelSelect").innerHTML = opts.map((o) =>
    `<option value="${o.pid}::${o.m.id}" ${o.pid === cfg.activeProviderId && o.m.id === cfg.activeModel ? "selected" : ""}>${label(o)}</option>`).join("");
  const cv = state.chatModel || "";
  $("#chatModelSelect").innerHTML = `<option value="">跟随全局模型</option>` + opts.map((o) =>
    `<option value="${o.pid}::${o.m.id}" ${cv === `${o.pid}::${o.m.id}` ? "selected" : ""}>${label(o)}</option>`).join("");
}
$("#modelSelect").onchange = (e) => {
  const [pid, ...m] = e.target.value.split("::");
  cfg.activeProviderId = pid;
  cfg.activeModel = m.join("::");
  saveCfg();
};
$("#chatModelSelect").onchange = (e) => { state.chatModel = e.target.value || null; };

/* ================= 右栏拖拽调宽 ================= */
(() => {
  const panel = $("#panel"), handle = $("#panelResizer");
  const saved = localStorage.getItem("pr.panelW");
  if (saved) panel.style.width = Math.min(window.innerWidth - 500, Math.max(280, +saved)) + "px";
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(window.innerWidth - 420, Math.max(280, window.innerWidth - e.clientX));
    panel.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    localStorage.setItem("pr.panelW", parseInt(panel.style.width));
  });
})();

/* ================= arXiv 论文搜索并加入阅读器(经本地 Python 服务器转发,无 CORS) ================= */
async function fetchWithCORS(url, onStatus) {
  onStatus?.("服务器转发中…");
  const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || "转发失败 HTTP " + r.status);
  }
  return r;
}

$("#btnArxiv").onclick = () => {
  $("#modalArxiv").hidden = false;
  $("#arxivQuery").focus();
};
$("#arxivClose").onclick = () => ($("#modalArxiv").hidden = true);
$("#modalArxiv").addEventListener("click", (e) => { if (e.target.id === "modalArxiv") $("#modalArxiv").hidden = true; });
$("#arxivQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#arxivSearchBtn").click(); });

$("#arxivSearchBtn").onclick = async () => {
  const q = $("#arxivQuery").value.trim();
  if (!q) return;
  const st = $("#arxivStatus");
  const box = $("#arxivResults");
  st.innerHTML = '<span class="spin"></span> 搜索中…';
  box.innerHTML = "";
  try {
    // 整串作为带引号的短语查询:避免标题中的空格/冒号/连字符破坏 arXiv 查询语法
    const phrase = q.replace(/["\r\n]/g, " ").trim();
    const api = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:"${phrase}"`)}&start=0&max_results=20&sortBy=relevance`;
    const resp = await fetchWithCORS(api, (msg) => (st.innerHTML = `<span class="spin"></span> ${msg}`));
    const xml = new DOMParser().parseFromString(await resp.text(), "text/xml");
    const entries = [...xml.querySelectorAll("entry")];
    if (!entries.length) { box.innerHTML = '<p class="hint">没有匹配结果</p>'; st.textContent = ""; return; }
    st.textContent = `共 ${entries.length} 条结果`;
    for (const e of entries) {
      const absUrl = e.querySelector("id")?.textContent || "";
      const item = {
        url: absUrl,
        pdf: absUrl.replace("/abs/", "/pdf/"),
        title: (e.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim(),
        summary: (e.querySelector("summary")?.textContent || "").replace(/\s+/g, " ").trim(),
        authors: [...e.querySelectorAll("author name")].map((n) => n.textContent),
        date: e.querySelector("published")?.textContent || "",
      };
      const div = document.createElement("div");
      div.className = "arxiv-item";
      div.innerHTML = `<div class="t">${item.title}</div>
        <div class="au">${item.authors.slice(0, 6).join(", ")}${item.authors.length > 6 ? " et al." : ""} · ${item.date.slice(0, 10)}</div>
        <div class="ab">${item.summary.slice(0, 300)}…</div>
        <div class="ops"><button>📥 添加到阅读器</button></div>`;
      const btn = div.querySelector("button");
      btn.onclick = async () => {
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> 下载中…';
        try {
          const r = await fetchWithCORS(item.pdf, (msg) => (btn.innerHTML = `<span class="spin"></span> ${msg}`));
          const blob = await r.blob();
          const file = new File([blob], item.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".pdf", { type: "application/pdf" });
          await addPDF(file, { title: item.title.slice(0, 80), folder: "arXiv" });
          btn.textContent = "✅ 已添加";
          btn.classList.add("done");
        } catch (err) {
          alert("添加失败:" + err.message);
          btn.disabled = false;
          btn.textContent = "📥 添加到阅读器";
        }
      };
      box.appendChild(div);
    }
  } catch (err) {
    st.innerHTML = "❌ " + err.message;
  }
};

/* ================= 初始化(异步:从本地服务器加载配置与数据) ================= */
async function boot() {
  // 1) 配置(若服务器无配置,尝试从旧浏览器 localStorage 迁移一次)
  try {
    const saved = await apiGet("/api/config");
    if (saved && saved.providers?.length) cfg = { ...cfg, ...saved };
    else {
      const legacy = JSON.parse(localStorage.getItem("pr.config") || "null");
      if (legacy?.providers?.length) {
        cfg = { ...cfg, ...legacy };
        console.info("已从浏览器 localStorage 迁移 AI 配置");
      }
    }
  } catch (e) { alert("无法连接本地服务器,请用 `python server.py` 启动后访问 http://localhost:8517\n" + e); }
  // 模型统一为 {id, name} 对象(name 为界面显示名,可空)
  for (const p of cfg.providers || []) {
    p.models = (p.models || []).map((m) => (typeof m === "string" ? { id: m, name: "" } : m)).filter((m) => m && m.id);
    if (!p.id) p.id = uid();
  }
  if (!cfg.providers?.length) cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveCfg();

  // 2) 文献库记录
  state.records = await loadRecords();

  // 3) 界面
  const sel = $("#transLang");
  if (cfg.lang && ![...sel.options].some((o) => o.value === cfg.lang)) sel.add(new Option(cfg.lang, cfg.lang));
  if (cfg.lang) sel.value = cfg.lang;
  pruneCrossFolderRelations(); // 启动时清理跨文件夹的历史关联
  saveRecords();
  rebuildModelSelects();
  renderTree();
  renderNotes();
}
boot();
