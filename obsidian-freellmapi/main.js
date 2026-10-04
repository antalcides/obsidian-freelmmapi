'use strict';

/*
 * FreeLLMAPI Connector — complemento para Obsidian
 * ------------------------------------------------
 * Conecta tu bóveda con un servidor FreeLLMAPI (auto-alojado, compatible
 * con la API de OpenAI) usando el endpoint /v1/chat/completions y /v1/models.
 *
 * Incluye RAG: indexa las notas de la bóveda (BM25 en memoria, sin
 * dependencias), busca los fragmentos más relevantes y los envía como
 * contexto al modelo.
 *
 * No requiere paso de compilación: manifest.json + main.js + styles.css.
 */

const obsidian = require('obsidian');
const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  MarkdownView,
  MarkdownRenderer,
  Modal,
  Notice,
  requestUrl,
  TFile
} = obsidian;

const VIEW_TYPE_CHAT = 'freellmapi-chat';

const DEFAULT_RAG_TEMPLATE =
  'Usa el CONTEXTO extraído de mis notas para responder la PREGUNTA. ' +
  'Si el contexto no contiene la información necesaria, dilo claramente y ' +
  'responde con tu propio conocimiento indicándolo. Cita las fuentes con el ' +
  'formato [1], [2] cuando te apoyes en el contexto.\n\n' +
  'CONTEXTO:\n{{contexto}}\n\nPREGUNTA:\n{{pregunta}}';

const DEFAULT_SETTINGS = {
  apiUrl: 'http://localhost:3001/v1',
  apiKey: '',
  model: 'auto',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt:
    'Eres un asistente integrado en Obsidian. Responde en el idioma del usuario, ' +
    'con claridad y concisión, usando Markdown cuando sea útil.',
  useStreaming: true,
  requestTimeout: 180,
  models: [],
  chatHistory: [],
  /* --- RAG --- */
  ragEnabled: true,
  ragTopK: 4,
  ragChunkSize: 1200,
  ragMaxFileKB: 300,
  ragExcludeFolders: '',
  ragAutoIndex: true,
  ragTemplate: DEFAULT_RAG_TEMPLATE
};

/* Palabras vacías mínimas (español + inglés) para el índice. */
const STOPWORDS = new Set(
  (
    'de la el los las un una unos unas unas al del lo les os me te se nos le ya ' +
    'o u y e a en que q con sin por para como cuando donde cual cuales quien ' +
    'es son ser soy eres somos sois era eran fue fueron seran sera ha han haber ' +
    'he has hemos mas pero si no tambien tampoco muy sobre entre desde hasta ' +
    'the and or for with from this that these those is are was were be been ' +
    'to of in on at by as it its an a i you he she we they them his her their ' +
    'not but if then than so such can could will would should have has had do does did'
  ).split(/\s+/)
);

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function basenameNoExt(path) {
  const b = String(path || '').split('/').pop();
  return b ? b.replace(/\.md$/i, '') : '';
}

function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    window.clearTimeout(t);
    t = window.setTimeout(function () {
      fn.apply(null, args);
    }, ms);
  };
}

async function renderMarkdownSafe(app, markdown, el, component) {
  try {
    if (typeof MarkdownRenderer.render === 'function') {
      await MarkdownRenderer.render(app, markdown, el, '', component);
    } else if (typeof MarkdownRenderer.renderMarkdown === 'function') {
      await MarkdownRenderer.renderMarkdown(markdown, el, '', component);
    } else {
      el.setText(markdown);
    }
  } catch (e) {
    el.setText(markdown);
  }
}

/* ------------------------------------------------------------------ */
/* Tokenizador y troceado de notas (para el índice RAG)                */
/* ------------------------------------------------------------------ */

function tokenize(text) {
  const out = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
  const s = String(text || '').toLowerCase();
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
    if (out.length >= 5000) break; // límite de seguridad por fragmento
  }
  return out;
}

/**
 * Divide una nota en fragmentos por párrafos (~chunkSize caracteres),
 * siguiendo el hilo de encabezados para registrar la sección de cada uno.
 * Devuelve [{ section, text }].
 */
function chunkNoteText(text, chunkSize) {
  const size = Math.max(300, Number(chunkSize) || 1200);
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/);

  const headingStack = [];
  const chunks = [];
  let cur = [];
  let curLen = 0;
  let section = '';
  let lastBlock = '';

  const pushChunk = function () {
    if (!cur.length) return;
    const t = cur.join('\n\n').trim();
    if (t) chunks.push({ section: section, text: t });
    cur = [];
    curLen = 0;
  };

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    // ¿El bloque empieza con un encabezado? Si es así, cierra el fragmento
    // de la sección anterior y actualiza el hilo de secciones.
    const nl = block.indexOf('\n');
    const firstLine = nl === -1 ? block : block.slice(0, nl);
    const hm = firstLine.match(/^(#{1,6})\s+(.+)$/);

    let content = block;
    if (hm) {
      pushChunk();
      lastBlock = '';
      const level = hm[1].length;
      const title = hm[2].trim();
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level: level, title: title });
      section = headingStack
        .map(function (h) {
          return h.title;
        })
        .join(' > ');

      const lines = block.split('\n');
      if (lines.length === 1) continue; // era solo el encabezado
      content = lines.slice(1).join('\n').trim();
      if (!content) continue;
    }

    const len = content.length;
    if (curLen && curLen + len > size) {
      pushChunk();
      // Solapamiento: reutiliza el bloque anterior si es corto (contexto).
      if (lastBlock && lastBlock.length <= 400) {
        cur.push(lastBlock);
        curLen = lastBlock.length;
      }
    }
    cur.push(content);
    curLen += len;
    lastBlock = content;

    if (curLen > size * 2) {
      pushChunk();
      lastBlock = '';
    }
  }
  pushChunk();
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Índice BM25 de la bóveda (en memoria, sin dependencias)             */
/* ------------------------------------------------------------------ */

class VaultIndex {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.chunks = new Map(); // id -> { id, path, section, text, len, tf }
    this.postings = new Map(); // término -> Set<id>
    this.files = new Map(); // path -> [id]
    this.totalLen = 0;
    this.nextId = 1;
    this.builtOnce = false;
    this.lastBuiltAt = 0;
    this.rebuilding = false;
  }

  shouldInclude(path, sizeBytes) {
    if (!path || !path.toLowerCase().endsWith('.md')) return false;
    const s = this.plugin.settings;
    const maxKB = Number(s.ragMaxFileKB) || 0;
    if (maxKB > 0 && sizeBytes && sizeBytes > maxKB * 1024) return false;
    const excl = String(s.ragExcludeFolders || '')
      .split(',')
      .map(function (x) {
        return x.trim().replace(/^\/+|\/+$/g, '');
      })
      .filter(Boolean);
    for (const e of excl) {
      if (
        path === e ||
        path.startsWith(e + '/') ||
        path.indexOf('/' + e + '/') !== -1
      ) {
        return false;
      }
    }
    return true;
  }

  reset() {
    this.chunks.clear();
    this.postings.clear();
    this.files.clear();
    this.totalLen = 0;
    this.nextId = 1;
  }

  addNote(path, content) {
    const parts = chunkNoteText(
      content,
      this.plugin.settings.ragChunkSize
    );
    const ids = [];
    for (const p of parts) {
      const tokens = tokenize(p.text);
      if (!tokens.length) continue;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

      const id = this.nextId++;
      this.chunks.set(id, {
        id: id,
        path: path,
        section: p.section,
        text: p.text,
        len: tokens.length,
        tf: tf
      });
      for (const t of tf.keys()) {
        let set = this.postings.get(t);
        if (!set) {
          set = new Set();
          this.postings.set(t, set);
        }
        set.add(id);
      }
      this.totalLen += tokens.length;
      ids.push(id);
    }
    if (ids.length) this.files.set(path, ids);
  }

  removeFile(path) {
    const ids = this.files.get(path);
    if (!ids) return;
    for (const id of ids) {
      const ch = this.chunks.get(id);
      if (!ch) continue;
      for (const t of ch.tf.keys()) {
        const set = this.postings.get(t);
        if (set) {
          set.delete(id);
          if (set.size === 0) this.postings.delete(t);
        }
      }
      this.totalLen -= ch.len;
      this.chunks.delete(id);
    }
    this.files.delete(path);
  }

  async updateFile(file) {
    if (this.rebuilding) return;
    const size = file.stat ? file.stat.size : 0;
    if (!(file instanceof TFile) || !this.shouldInclude(file.path, size)) {
      this.removeFile(file.path);
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    this.removeFile(file.path);
    this.addNote(file.path, content);
  }

  async rebuildAll() {
    this.rebuilding = true;
    try {
      this.reset();
      const files = this.app.vault.getMarkdownFiles();
      let n = 0;
      for (const f of files) {
        const size = f.stat ? f.stat.size : 0;
        if (!this.shouldInclude(f.path, size)) continue;
        try {
          const content = await this.app.vault.cachedRead(f);
          this.addNote(f.path, content);
          n++;
        } catch (e) {
          /* nota ilegible: se ignora */
        }
      }
      this.builtOnce = true;
      this.lastBuiltAt = Date.now();
      return { files: n, chunks: this.chunks.size };
    } finally {
      this.rebuilding = false;
    }
  }

  /** Búsqueda BM25. Devuelve [{ path, section, text, score }] */
  search(query, k) {
    const terms = Array.from(new Set(tokenize(query)));
    const out = [];
    if (!terms.length || this.chunks.size === 0) return out;

    const N = this.chunks.size;
    const avg = this.totalLen / N;
    const K1 = 1.2;
    const B = 0.75;
    const scores = new Map();

    for (const t of terms) {
      const post = this.postings.get(t);
      if (!post || post.size === 0) continue;
      const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
      for (const id of post) {
        const ch = this.chunks.get(id);
        if (!ch) continue;
        const tf = ch.tf.get(t) || 0;
        if (!tf) continue;
        const norm = 1 - B + (B * ch.len) / avg;
        const s = (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
        scores.set(id, (scores.get(id) || 0) + s);
      }
    }
    if (scores.size === 0) return out;

    const sorted = Array.from(scores.entries())
      .sort(function (a, b2) {
        return b2[1] - a[1];
      })
      .slice(0, Math.max(1, Number(k) || 4));

    for (const entry of sorted) {
      const ch = this.chunks.get(entry[0]);
      if (!ch) continue;
      out.push({
        path: ch.path,
        section: ch.section,
        text: ch.text,
        score: Math.round(entry[1] * 100) / 100
      });
    }
    return out;
  }

  stats() {
    return {
      files: this.files.size,
      chunks: this.chunks.size,
      builtOnce: this.builtOnce,
      lastBuiltAt: this.lastBuiltAt
    };
  }
}

/* ------------------------------------------------------------------ */
/* Cliente FreeLLMAPI (compatible con OpenAI)                          */
/* ------------------------------------------------------------------ */

class FreeLLMAClient {
  constructor(settings) {
    this.s = settings;
  }

  url(path) {
    return normalizeBaseUrl(this.s.apiUrl) + path;
  }

  headers(withJson) {
    const h = {};
    if (withJson) h['Content-Type'] = 'application/json';
    const key = String(this.s.apiKey || '').trim();
    if (key) h['Authorization'] = 'Bearer ' + key;
    return h;
  }

  buildPayload(messages, stream) {
    const payload = {
      model: String(this.s.model || 'auto'),
      messages: messages,
      stream: !!stream
    };
    const temp = Number(this.s.temperature);
    if (!Number.isNaN(temp)) payload.temperature = temp;
    const maxTok = Number(this.s.maxTokens);
    if (maxTok > 0) payload.max_tokens = maxTok;
    return payload;
  }

  async listModels() {
    const res = await requestUrl({
      url: this.url('/models'),
      method: 'GET',
      headers: this.headers(false),
      throw: false
    });
    if (res.status >= 400) {
      throw new Error('HTTP ' + res.status + ' al listar modelos');
    }
    let json = null;
    try {
      json = res.json;
    } catch (e) {
      throw new Error('El servidor no devolvió JSON válido en /models');
    }
    const data = (json && json.data) || [];
    const ids = data
      .map(function (m) {
        return m && m.id ? String(m.id) : null;
      })
      .filter(Boolean);
    return Array.from(new Set(ids)).sort();
  }

  /** Chat con streaming (fetch) + fallback sin streaming (requestUrl). */
  async chat(messages, opts) {
    const options = opts || {};
    if (this.s.useStreaming) {
      try {
        return await this.chatStream(messages, options.onDelta, options.signal);
      } catch (err) {
        if (options.signal && options.signal.aborted) {
          const e = new Error('Generación cancelada.');
          e.isCancel = true;
          throw e;
        }
        // Fallback: entornos donde fetch está bloqueado por CORS.
        return await this.chatNonStream(messages);
      }
    }
    return await this.chatNonStream(messages);
  }

  async chatStream(messages, onDelta, externalSignal) {
    const ctrl = new AbortController();
    let cancelledByUser = false;
    let timedOut = false;

    const abortUser = function () {
      cancelledByUser = true;
      ctrl.abort();
    };
    const abortTimeout = function () {
      timedOut = true;
      ctrl.abort();
    };

    if (externalSignal) {
      if (externalSignal.aborted) cancelledByUser = true;
      else externalSignal.addEventListener('abort', abortUser, { once: true });
    }
    const timeoutMs = (Number(this.s.requestTimeout) || 180) * 1000;
    const timer = window.setTimeout(abortTimeout, timeoutMs);

    try {
      if (cancelledByUser) throw new Error('Generación cancelada.');

      const res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(this.buildPayload(messages, true)),
        signal: ctrl.signal
      });

      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail =
            (j && j.error && (j.error.message || j.error.code)) ||
            (j && j.message) ||
            '';
        } catch (e) {
          /* ignorar */
        }
        const err = new Error(
          'HTTP ' + res.status + (detail ? ' — ' + detail : '')
        );
        err.status = res.status;
        throw err;
      }

      if (!res.body) throw new Error('El servidor no devolvió un stream.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';

      const handleLine = function (rawLine) {
        const line = rawLine.trim();
        if (!line || line.indexOf('data:') !== 0) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let delta = '';
        try {
          const json = JSON.parse(data);
          const ch = json && json.choices && json.choices[0];
          if (ch) {
            delta =
              (ch.delta && ch.delta.content) ||
              (ch.message && ch.message.content) ||
              ch.text ||
              '';
          }
        } catch (e) {
          return;
        }
        if (delta) {
          full += delta;
          if (onDelta) onDelta(full, delta);
        }
      };

      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      }

      if (!full) throw new Error('La respuesta del modelo llegó vacía.');
      return full;
    } catch (err) {
      if (cancelledByUser) {
        const e = new Error('Generación cancelada.');
        e.isCancel = true;
        throw e;
      }
      if (timedOut) throw new Error('Tiempo de espera agotado.');
      throw err;
    } finally {
      window.clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', abortUser);
      }
    }
  }

  async chatNonStream(messages) {
    let res;
    try {
      res = await requestUrl({
        url: this.url('/chat/completions'),
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(this.buildPayload(messages, false)),
        throw: false
      });
    } catch (e) {
      throw new Error(
        'No se pudo conectar con FreeLLMAPI (' +
          this.url('/chat/completions') +
          '). ¿Está el servidor en ejecución?'
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'HTTP ' +
          res.status +
          ': clave de API no válida. Copia tu clave unificada del panel de FreeLLMAPI (página "Keys") en los ajustes del complemento.'
      );
    }
    if (res.status >= 400) {
      let detail = '';
      try {
        const j = res.json;
        detail =
          (j && j.error && (j.error.message || j.error.code)) ||
          (j && j.message) ||
          '';
      } catch (e) {
        /* ignorar */
      }
      throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }

    let json = null;
    try {
      json = res.json;
    } catch (e) {
      throw new Error('Respuesta no válida del servidor.');
    }
    const ch = json && json.choices && json.choices[0];
    const text =
      (ch && ch.message && ch.message.content) || (ch && ch.text) || '';
    if (!text) throw new Error('La respuesta del modelo llegó vacía.');
    return text;
  }
}

/* ------------------------------------------------------------------ */
/* Vista de chat (barra lateral derecha)                               */
/* ------------------------------------------------------------------ */

class ChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.busy = false;
    this.abortCtrl = null;
    this.infoTimer = null;
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText() {
    return 'Chat de FreeLLMAPI';
  }
  getIcon() {
    return 'bot';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('freellmapi-chat');

    /* --- Cabecera: selector de modelo + acciones --- */
    const header = root.createDiv({ cls: 'freellmapi-chat-header' });

    this.modelSelect = header.createEl('select', {
      cls: 'dropdown freellmapi-model-select'
    });
    this.fillModelSelect();
    this.modelSelect.addEventListener('change', () => {
      this.plugin.settings.model = this.modelSelect.value;
      this.plugin.saveSettings();
    });

    const reloadBtn = header.createEl('button', {
      text: '⟳',
      attr: { title: 'Recargar lista de modelos', 'aria-label': 'Recargar modelos' }
    });
    reloadBtn.addEventListener('click', () => this.reloadModels());

    this.ragBtn = header.createEl('button', {
      text: '📚',
      attr: {
        title: 'RAG: usar tus notas como contexto (activar/desactivar)',
        'aria-label': 'RAG'
      }
    });
    this.ragBtn.addEventListener('click', async () => {
      const p = this.plugin;
      p.settings.ragEnabled = !p.settings.ragEnabled;
      await p.saveSettings();
      this.syncRagToggle();
      new Notice(
        p.settings.ragEnabled
          ? 'RAG activado: el chat buscará en tus notas.'
          : 'RAG desactivado.'
      );
    });
    this.syncRagToggle();

    const newChatBtn = header.createEl('button', {
      text: 'Nueva',
      attr: { title: 'Empezar una conversación nueva', 'aria-label': 'Nueva conversación' }
    });
    newChatBtn.addEventListener('click', () => this.newConversation());

    const settingsBtn = header.createEl('button', {
      text: '⚙',
      attr: { title: 'Abrir ajustes del complemento', 'aria-label': 'Ajustes' }
    });
    settingsBtn.addEventListener('click', () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
    });

    /* --- Contenedor de mensajes --- */
    this.messagesEl = root.createDiv({ cls: 'freellmapi-chat-messages' });
    this.renderHistory();

    /* --- Línea de información (RAG) --- */
    this.infoEl = root.createDiv({ cls: 'freellmapi-chat-info' });

    /* --- Barra de estado / errores --- */
    this.statusEl = root.createDiv({ cls: 'freellmapi-chat-status' });

    /* --- Ayuda + entrada de texto --- */
    root.createDiv({
      cls: 'freellmapi-chat-hint',
      text: 'Enter para enviar · Shift+Enter para salto de línea'
    });

    const inputRow = root.createDiv({ cls: 'freellmapi-chat-input' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'freellmapi-input',
      attr: {
        placeholder: 'Escribe tu mensaje…',
        rows: '2'
      }
    });
    this.inputEl.addEventListener('keydown', (evt) => {
      if (
        evt.key === 'Enter' &&
        !evt.shiftKey &&
        !evt.isComposing &&
        !this.busy
      ) {
        evt.preventDefault();
        this.send();
      }
    });
    this.inputEl.addEventListener('input', () => this.autoResize());

    this.sendBtn = inputRow.createEl('button', {
      cls: 'mod-cta freellmapi-send',
      text: 'Enviar'
    });
    this.sendBtn.addEventListener('click', () => {
      if (this.busy) {
        if (this.abortCtrl) this.abortCtrl.abort();
      } else {
        this.send();
      }
    });

    this.autoResize();
  }

  async onClose() {
    if (this.abortCtrl) this.abortCtrl.abort();
    if (this.infoTimer) window.clearTimeout(this.infoTimer);
    this.contentEl.empty();
  }

  /* ----------------------- helpers de UI ----------------------- */

  autoResize() {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height =
      Math.min(this.inputEl.scrollHeight, 200) + 'px';
  }

  setInput(text) {
    if (!this.inputEl) return;
    this.inputEl.value = text || '';
    this.autoResize();
    this.inputEl.focus();
  }

  fillModelSelect() {
    if (!this.modelSelect) return;
    const sel = this.modelSelect;
    sel.empty();
    const current = this.plugin.settings.model || 'auto';
    const set = new Set(this.plugin.settings.models || []);
    set.add(current);
    if (!this.plugin.settings.models || this.plugin.settings.models.length === 0) {
      set.add('auto');
    }
    const list = Array.from(set);
    list.sort(function (a, b) {
      if (a === 'auto') return -1;
      if (b === 'auto') return 1;
      return a.localeCompare(b);
    });
    for (const m of list) {
      sel.createEl('option', { value: m, text: m });
    }
    sel.value = current;
    if (sel.value !== current) sel.value = list[0];
  }

  syncRagToggle() {
    if (!this.ragBtn) return;
    if (this.plugin.settings.ragEnabled) {
      this.ragBtn.addClass('freellmapi-toggled');
    } else {
      this.ragBtn.removeClass('freellmapi-toggled');
    }
  }

  scrollBottom() {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  setStatus(msg) {
    if (!this.statusEl) return;
    if (msg) {
      this.statusEl.setText(msg);
      this.statusEl.addClass('visible');
    } else {
      this.statusEl.removeClass('visible');
      this.statusEl.setText('');
    }
  }

  setInfo(msg, ttl) {
    if (!this.infoEl) return;
    if (this.infoTimer) {
      window.clearTimeout(this.infoTimer);
      this.infoTimer = null;
    }
    if (msg) {
      this.infoEl.setText(msg);
      this.infoEl.addClass('visible');
      if (ttl) {
        this.infoTimer = window.setTimeout(() => {
          if (this.infoEl) this.infoEl.removeClass('visible');
        }, ttl);
      }
    } else {
      this.infoEl.removeClass('visible');
      this.infoEl.setText('');
    }
  }

  setBusy(busy) {
    this.busy = busy;
    if (!this.sendBtn) return;
    if (busy) {
      this.sendBtn.setText('⏹ Detener');
      this.sendBtn.addClass('freellmapi-stop');
      this.sendBtn.removeClass('mod-cta');
    } else {
      this.sendBtn.setText('Enviar');
      this.sendBtn.removeClass('freellmapi-stop');
      this.sendBtn.addClass('mod-cta');
    }
  }

  renderHistory() {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    const history = this.plugin.settings.chatHistory || [];
    if (history.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: 'freellmapi-chat-empty' });
      empty.createDiv({
        cls: 'freellmapi-chat-empty-title',
        text: 'Chat con FreeLLMAPI'
      });
      empty.createDiv({
        text:
          'Escribe un mensaje para empezar. Con el botón 📚 activado, el ' +
          'asistente busca en tus notas y las usa como contexto (RAG).'
      });
      return;
    }
    for (const m of history) {
      this.appendMessage(m.role, m.content, { save: false });
    }
    this.scrollBottom();
  }

  appendMessage(role, content, opts) {
    const options = opts || {};
    const cls =
      role === 'user'
        ? 'freellmapi-msg freellmapi-msg-user'
        : 'freellmapi-msg freellmapi-msg-assistant';
    const msgEl = this.messagesEl.createDiv({ cls: cls });
    const contentEl = msgEl.createDiv({ cls: 'freellmapi-msg-content' });

    if (role === 'assistant' && content) {
      renderMarkdownSafe(this.app, content, contentEl, this);
    } else {
      contentEl.setText(content || '');
    }

    if (role === 'assistant' && content && !options.skipActions) {
      this.addMessageActions(msgEl, content);
    }
    this.scrollBottom();
    return msgEl;
  }

  addMessageActions(msgEl, text) {
    const actions = msgEl.createDiv({ cls: 'freellmapi-msg-actions' });

    const copyBtn = actions.createEl('button', { text: 'Copiar' });
    copyBtn.addEventListener('click', () => {
      navigator.clipboard
        .writeText(text)
        .then(function () {
          new Notice('Copiado al portapapeles.');
        })
        .catch(function () {
          new Notice('No se pudo copiar.');
        });
    });

    const insertBtn = actions.createEl('button', { text: 'Insertar en nota' });
    insertBtn.addEventListener('click', () => this.insertIntoNote(text));
  }

  insertIntoNote(text) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('Abre una nota para poder insertar el texto.');
      return;
    }
    view.editor.replaceSelection(text);
    new Notice('Texto insertado en la nota.');
  }

  newConversation() {
    this.plugin.settings.chatHistory = [];
    this.plugin.saveSettings();
    this.renderHistory();
    this.setStatus('');
    this.setInfo('');
    new Notice('Conversación borrada.');
  }

  async reloadModels() {
    this.setStatus('Cargando modelos…');
    try {
      const models = await this.plugin.client().listModels();
      this.plugin.settings.models = models;
      await this.plugin.saveSettings();
      this.fillModelSelect();
      this.setStatus('');
      new Notice('FreeLLMAPI: ' + models.length + ' modelos disponibles.');
    } catch (err) {
      this.setStatus('Error al cargar modelos: ' + err.message);
      new Notice('Error al cargar modelos: ' + err.message, 8000);
    }
  }

  /* ----------------------- envío ----------------------- */

  async send() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    const settings = this.plugin.settings;
    if (!normalizeBaseUrl(settings.apiUrl)) {
      new Notice('Configura la URL de FreeLLMAPI en los ajustes.', 6000);
      return;
    }

    this.setStatus('');
    this.setInfo('');
    this.inputEl.value = '';
    this.autoResize();

    this.appendMessage('user', text);
    settings.chatHistory.push({ role: 'user', content: text });
    this.trimHistory();
    this.plugin.saveSettings();

    this.setBusy(true);
    this.abortCtrl = new AbortController();

    /* --- RAG: recuperar contexto de las notas --- */
    let ragResults = null;
    if (settings.ragEnabled) {
      try {
        ragResults = await this.plugin.getRagResults(text, (m, ttl) =>
          this.setInfo(m, ttl)
        );
      } catch (err) {
        this.setInfo('⚠️ RAG omitido en este mensaje: ' + err.message, 10000);
      }
    }

    if (ragResults && ragResults.length) {
      const nNotes = new Set(
        ragResults.map(function (r) {
          return r.path;
        })
      ).size;
      this.setInfo(
        '📚 Contexto: ' +
          ragResults.length +
          ' fragmento(s) de ' +
          nNotes +
          ' nota(s).',
        12000
      );
    } else if (settings.ragEnabled && !ragResults) {
      /* sin índice o sin resultados: se informa arriba */
    } else if (settings.ragEnabled) {
      this.setInfo(
        'ℹ️ RAG activo, pero no encontré notas relacionadas con el mensaje.',
        8000
      );
    }

    const finalUserContent =
      ragResults && ragResults.length
        ? this.plugin.buildRagPrompt(text, ragResults)
        : text;

    const messages = [];
    if (settings.systemPrompt && settings.systemPrompt.trim()) {
      messages.push({ role: 'system', content: settings.systemPrompt.trim() });
    }
    const hist = settings.chatHistory.slice(-40);
    for (let i = 0; i < hist.length - 1; i++) {
      messages.push({ role: hist[i].role, content: hist[i].content });
    }
    messages.push({ role: 'user', content: finalUserContent });

    const msgEl = this.messagesEl.createDiv({
      cls: 'freellmapi-msg freellmapi-msg-assistant'
    });
    const contentEl = msgEl.createDiv({ cls: 'freellmapi-msg-content' });
    contentEl.setText('…');
    this.scrollBottom();

    try {
      let full = await this.plugin.client().chat(messages, {
        signal: this.abortCtrl.signal,
        onDelta: (fullText) => {
          contentEl.setText(fullText);
          this.scrollBottom();
        }
      });

      if (ragResults && ragResults.length) {
        full = full.trim() + buildSourcesBlock(ragResults);
      }

      contentEl.empty();
      await renderMarkdownSafe(this.app, full, contentEl, this);
      this.addMessageActions(msgEl, full);

      settings.chatHistory.push({ role: 'assistant', content: full });
      this.trimHistory();
      await this.plugin.saveSettings();
      this.scrollBottom();
    } catch (err) {
      msgEl.remove();
      // La pregunta no obtuvo respuesta: la retiramos del historial.
      const h = settings.chatHistory;
      if (h.length && h[h.length - 1].role === 'user') h.pop();
      this.plugin.saveSettings();
      if (!err.isCancel) {
        this.setStatus(err.message || String(err));
        new Notice('Error de FreeLLMAPI: ' + (err.message || err), 8000);
      }
    } finally {
      this.abortCtrl = null;
      this.setBusy(false);
      this.inputEl.focus();
    }
  }

  trimHistory() {
    const h = this.plugin.settings.chatHistory;
    if (h.length > 200) {
      this.plugin.settings.chatHistory = h.slice(-200);
    }
  }
}

/* ------------------------------------------------------------------ */
/* RAG: construcción del prompt y bloque de fuentes                    */
/* ------------------------------------------------------------------ */

function buildSourcesBlock(results) {
  const parts = results.map(function (r, i) {
    return '[' + (i + 1) + '] [[' + basenameNoExt(r.path) + ']]';
  });
  return '\n\n---\n📌 **Fuentes:** ' + parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Modales: preguntar a las notas y buscar en las notas                */
/* ------------------------------------------------------------------ */

class AskNotesModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.empty();
    contentEl.addClass('freellmapi-modal');

    contentEl.createEl('h3', { text: 'Preguntar a tus notas (RAG)' });
    contentEl.createDiv({
      cls: 'freellmapi-modal-desc',
      text:
        'Se buscará en el índice de tu bóveda y se enviarán los fragmentos ' +
        'más relevantes como contexto al modelo.'
    });

    const ta = contentEl.createEl('textarea', {
      cls: 'freellmapi-modal-input',
      attr: {
        placeholder: '¿Qué quieres preguntar sobre tus notas?',
        rows: '4'
      }
    });

    const row = contentEl.createDiv({ cls: 'freellmapi-modal-buttons' });
    const cancelBtn = row.createEl('button', { text: 'Cancelar' });
    cancelBtn.addEventListener('click', () => this.close());

    const submit = async () => {
      const q = ta.value.trim();
      if (!q) return;
      this.close();
      const view = await this.plugin.activateView();
      if (!view) return;
      this.plugin.settings.ragEnabled = true;
      await this.plugin.saveSettings();
      view.syncRagToggle();
      view.setInput(q);
      view.send();
    };

    const sendBtn = row.createEl('button', {
      text: 'Preguntar',
      cls: 'mod-cta'
    });
    sendBtn.addEventListener('click', () => submit());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });

    window.setTimeout(() => ta.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class NoteSearchModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.results = [];
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.empty();
    contentEl.addClass('freellmapi-modal');

    contentEl.createEl('h3', { text: 'Buscar en tus notas (índice RAG)' });

    this.searchInput = contentEl.createEl('input', {
      cls: 'freellmapi-modal-input',
      attr: { type: 'text', placeholder: 'Palabras clave…' }
    });
    this.summaryEl = contentEl.createDiv({ cls: 'freellmapi-modal-desc' });
    this.resultsEl = contentEl.createDiv({ cls: 'freellmapi-search-results' });

    this.runSearchDebounced = debounce(() => this.runSearch(), 250);
    this.searchInput.addEventListener('input', () => this.runSearchDebounced());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.results.length) this.openResult(this.results[0]);
      }
    });

    this.summaryEl.setText(
      this.plugin.index.builtOnce
        ? 'Escribe para buscar en las notas indexadas.'
        : 'El índice aún no se ha construido. Usa el comando «FreeLLMAPI: Reconstruir índice de notas» o envía un mensaje con RAG activado.'
    );

    window.setTimeout(() => this.searchInput.focus(), 50);
  }

  runSearch() {
    const q = this.searchInput.value.trim();
    this.resultsEl.empty();
    this.results = [];
    if (!q) {
      this.summaryEl.setText('Escribe para buscar en las notas indexadas.');
      return;
    }
    const res = this.plugin.index.search(q, 10);
    this.results = res;
    if (!res.length) {
      this.summaryEl.setText('Sin resultados para «' + q + '».');
      return;
    }
    this.summaryEl.setText(res.length + ' resultado(s) para «' + q + '»:');
    for (const r of res) {
      const item = this.resultsEl.createDiv({
        cls: 'freellmapi-search-result'
      });
      item.createDiv({
        cls: 'freellmapi-search-title',
        text: basenameNoExt(r.path)
      });
      item.createDiv({
        cls: 'freellmapi-search-path',
        text: r.path + (r.section ? ' — ' + r.section : '')
      });
      const snippet =
        r.text.replace(/\s+/g, ' ').slice(0, 180) +
        (r.text.length > 180 ? '…' : '');
      item.createDiv({ cls: 'freellmapi-search-snippet', text: snippet });
      item.addEventListener('click', () => this.openResult(r));
    }
  }

  openResult(r) {
    const f = this.app.vault.getAbstractFileByPath(r.path);
    if (f instanceof TFile) {
      this.close();
      this.app.workspace.getLeaf('tab').openFile(f);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Pestaña de ajustes                                                  */
/* ------------------------------------------------------------------ */

class FreeLLMSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();

    new Setting(containerEl).setName('FreeLLMAPI').setHeading();

    new Setting(containerEl)
      .setName('URL base de la API')
      .setDesc(
        'Endpoint compatible con OpenAI de tu servidor FreeLLMAPI. ' +
          'Por defecto: http://localhost:3001/v1'
      )
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:3001/v1')
          .setValue(this.plugin.settings.apiUrl)
          .onChange((value) => {
            this.plugin.settings.apiUrl = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Clave de API (unified key)')
      .setDesc(
        'La clave unificada que copias del panel de FreeLLMAPI (página "Keys"). ' +
          'Déjala vacía si tu servidor no exige autenticación.'
      )
      .addText((text) => {
        text
          .setPlaceholder('flm-…')
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => {
            this.plugin.settings.apiKey = value.trim();
            this.plugin.saveSettings();
          });
        text.inputEl.setAttribute('type', 'password');
      });

    new Setting(containerEl)
      .setName('Modelo')
      .setDesc(
        'Nombre del modelo (p. ej. "auto", "fusion" o uno concreto de /v1/models).'
      )
      .addText((text) =>
        text
          .setPlaceholder('auto')
          .setValue(this.plugin.settings.model)
          .onChange((value) => {
            this.plugin.settings.model = value.trim();
            this.plugin.saveSettings();
            this.plugin.syncChatView();
          })
      );

    new Setting(containerEl)
      .setName('Probar conexión y cargar modelos')
      .setDesc(
        'Consulta GET /v1/models de tu servidor y guarda la lista para los desplegables.'
      )
      .addButton((btn) =>
        btn.setButtonText('Probar conexión').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Probando…');
          try {
            const models = await this.plugin.client().listModels();
            this.plugin.settings.models = models;
            await this.plugin.saveSettings();
            this.plugin.syncChatView();
            new Notice(
              '✅ Conexión correcta — ' + models.length + ' modelos disponibles.'
            );
            btn.setDisabled(false);
            btn.setButtonText('Probar conexión');
          } catch (err) {
            new Notice('❌ Sin conexión: ' + err.message, 10000);
            btn.setDisabled(false);
            btn.setButtonText('Probar conexión');
          }
        })
      );

    new Setting(containerEl).setName('Generación').setHeading();

    new Setting(containerEl)
      .setName('Temperatura')
      .setDesc('0 = más determinista, 2 = más creativo.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.05)
          .setValue(Number(this.plugin.settings.temperature) || 0.7)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.temperature = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Máximo de tokens de respuesta')
      .setDesc('Límite de tokens que puede devolver el modelo.')
      .addText((text) => {
        text
          .setPlaceholder('2048')
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange((value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.maxTokens = Number.isNaN(n) ? 0 : n;
            this.plugin.saveSettings();
          });
        text.inputEl.setAttribute('type', 'number');
        text.inputEl.setAttribute('min', '1');
      });

    new Setting(containerEl)
      .setName('Streaming (respuestas en tiempo real)')
      .setDesc(
        'Muestra la respuesta a medida que se genera. Si tu servidor tiene ' +
          'problemas con streams, desactívalo.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.useStreaming)
          .onChange((value) => {
            this.plugin.settings.useStreaming = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Tiempo máximo de espera (segundos)')
      .setDesc('Se cancela la petición si el modelo tarda más de este tiempo.')
      .addText((text) => {
        text
          .setPlaceholder('180')
          .setValue(String(this.plugin.settings.requestTimeout))
          .onChange((value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.requestTimeout = Number.isNaN(n)
              ? 180
              : n;
            this.plugin.saveSettings();
          });
        text.inputEl.setAttribute('type', 'number');
        text.inputEl.setAttribute('min', '10');
      });

    new Setting(containerEl)
      .setName('Instrucciones del sistema (system prompt)')
      .setDesc('Se envían con cada petición para guiar al modelo.')
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.systemPrompt).onChange((value) => {
          this.plugin.settings.systemPrompt = value;
          this.plugin.saveSettings();
        });
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = '100%';
      });

    /* ------------------------- RAG ------------------------- */

    new Setting(containerEl).setName('RAG — contexto de tus notas').setHeading();

    new Setting(containerEl)
      .setName('Usar mis notas como contexto (RAG)')
      .setDesc(
        'Cuando está activo, el chat busca en tu bóveda y añade los fragmentos ' +
          'más relevantes como contexto. También se activa con el botón 📚 del chat.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.ragEnabled)
          .onChange((value) => {
            this.plugin.settings.ragEnabled = value;
            this.plugin.saveSettings();
            this.plugin.syncChatView();
          })
      );

    new Setting(containerEl)
      .setName('Fragmentos de contexto (top-K)')
      .setDesc('Cuántos fragmentos de notas se envían como contexto en cada pregunta.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setValue(Number(this.plugin.settings.ragTopK) || 4)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.ragTopK = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Tamaño de fragmento (caracteres)')
      .setDesc('Las notas se trocean en bloques de este tamaño aproximado.')
      .addText((text) => {
        text
          .setPlaceholder('1200')
          .setValue(String(this.plugin.settings.ragChunkSize))
          .onChange((value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.ragChunkSize = Number.isNaN(n) ? 1200 : n;
            this.plugin.saveSettings();
          });
        text.inputEl.setAttribute('type', 'number');
        text.inputEl.setAttribute('min', '300');
      });

    new Setting(containerEl)
      .setName('Tamaño máximo de nota a indexar (KB)')
      .setDesc('Las notas más grandes se omiten. Usa 0 para no limitar.')
      .addText((text) => {
        text
          .setPlaceholder('300')
          .setValue(String(this.plugin.settings.ragMaxFileKB))
          .onChange((value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.ragMaxFileKB = Number.isNaN(n) ? 300 : n;
            this.plugin.saveSettings();
          });
        text.inputEl.setAttribute('type', 'number');
        text.inputEl.setAttribute('min', '0');
      });

    new Setting(containerEl)
      .setName('Carpetas excluidas del índice')
      .setDesc(
        'Nombres o rutas separados por comas, p. ej.: plantillas, diario/privado'
      )
      .addText((text) =>
        text
          .setPlaceholder('plantillas, archivado')
          .setValue(this.plugin.settings.ragExcludeFolders)
          .onChange((value) => {
            this.plugin.settings.ragExcludeFolders = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Indexar automáticamente al iniciar')
      .setDesc(
        'Construye el índice en segundo plano cuando arranca Obsidian. ' +
          'Si lo desactivas, el índice se construirá la primera vez que se use el RAG.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.ragAutoIndex)
          .onChange((value) => {
            this.plugin.settings.ragAutoIndex = value;
            this.plugin.saveSettings();
          })
      );

    const st = this.plugin.index.stats();
    const statsDesc = st.builtOnce
      ? 'Notas indexadas: ' +
        st.files +
        ' · Fragmentos: ' +
        st.chunks +
        ' · Última construcción: ' +
        new Date(st.lastBuiltAt).toLocaleString()
      : 'El índice aún no se ha construido.';

    new Setting(containerEl)
      .setName('Estado del índice')
      .setDesc(statsDesc)
      .addButton((btn) =>
        btn.setButtonText('Reconstruir índice').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Indexando…');
          try {
            const s2 = await this.plugin.rebuildIndex(true, null);
            new Notice(
              '📚 Índice reconstruido: ' + s2.files + ' notas, ' + s2.chunks + ' fragmentos.'
            );
          } catch (err) {
            new Notice('Error al indexar: ' + (err.message || err), 8000);
          }
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Plantilla del prompt RAG')
      .setDesc(
        'Marcadores disponibles: {{contexto}} (fragmentos recuperados) y {{pregunta}} (tu pregunta).'
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.ragTemplate).onChange((value) => {
          this.plugin.settings.ragTemplate = value;
          this.plugin.saveSettings();
        });
        ta.inputEl.rows = 7;
        ta.inputEl.style.width = '100%';
      });

    new Setting(containerEl).setName('Datos').setHeading();

    new Setting(containerEl)
      .setName('Borrar historial del chat')
      .setDesc(
        'El historial se guarda localmente en data.json dentro del complemento. ' +
          'El índice de notas vive solo en memoria: nunca se escribe en disco.'
      )
      .addButton((btn) =>
        btn
          .setButtonText('Borrar historial')
          .setWarning()
          .onClick(() => {
            this.plugin.settings.chatHistory = [];
            this.plugin.saveSettings();
            this.plugin.refreshChatView();
            new Notice('Historial borrado.');
          })
      );
  }
}

/* ------------------------------------------------------------------ */
/* Complemento principal                                               */
/* ------------------------------------------------------------------ */

class FreeLLMAPIPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) || {}
    );
    if (!Array.isArray(this.settings.chatHistory)) {
      this.settings.chatHistory = [];
    }
    if (!Array.isArray(this.settings.models)) {
      this.settings.models = [];
    }
    /* Migración desde la v1.0: ajustes RAG por defecto si faltan. */
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (this.settings[key] === undefined) {
        this.settings[key] = DEFAULT_SETTINGS[key];
      }
    }

    /*
     * FIX v1.1.0: definimos saveSettings() explícitamente (patrón del
     * plugin de ejemplo oficial) para no depender del método de la clase
     * base Plugin, que no está disponible en todas las versiones.
     */
    this.saveSettings = async () => {
      try {
        await this.saveData(this.settings);
      } catch (e) {
        console.error('FreeLLMAPI Connector: no se pudo guardar data.json', e);
      }
    };

    /* Índice RAG en memoria. */
    this.index = new VaultIndex(this.app, this);
    this.scheduleIndexUpdate = debounce((file) => {
      this.index
        .updateFile(file)
        .catch(function (e) {
          console.error('FreeLLMAPI Connector: error al actualizar índice', e);
        });
    }, 1500);

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('bot', 'FreeLLMAPI: abrir chat', () => {
      this.activateView();
    });

    this.addSettingTab(new FreeLLMSettingTab(this.app, this));

    /* Mantener el índice al día con los cambios de la bóveda. */
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.index.builtOnce) return;
        const size = file.stat ? file.stat.size : 0;
        if (this.index.shouldInclude(file.path, size)) {
          this.scheduleIndexUpdate(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.index.removeFile(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.index.removeFile(oldPath);
        if (this.index.builtOnce) {
          const size = file.stat ? file.stat.size : 0;
          if (this.index.shouldInclude(file.path, size)) {
            this.scheduleIndexUpdate(file);
          }
        }
      })
    );

    /* ----------------------- comandos ----------------------- */

    this.addCommand({
      id: 'open-chat',
      name: 'Abrir chat',
      callback: () => this.activateView()
    });

    this.addCommand({
      id: 'new-chat',
      name: 'Nueva conversación (borrar historial)',
      callback: () => {
        this.settings.chatHistory = [];
        this.saveSettings();
        this.refreshChatView();
        new Notice('Conversación borrada.');
      }
    });

    this.addCommand({
      id: 'ask-notes-rag',
      name: 'Preguntar a mis notas (RAG)…',
      callback: () => {
        new AskNotesModal(this.app, this).open();
      }
    });

    this.addCommand({
      id: 'search-notes-index',
      name: 'Buscar en mis notas (índice RAG)…',
      callback: () => {
        new NoteSearchModal(this.app, this).open();
      }
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Reconstruir índice de notas',
      callback: () => {
        this.rebuildIndex(true, null).catch(function (e) {
          new Notice('Error al indexar: ' + (e.message || e), 8000);
        });
      }
    });

    this.addCommand({
      id: 'summarize-selection',
      name: 'Resumir selección',
      editorCallback: (editor) => this.runEditorAction(editor, 'summarize')
    });

    this.addCommand({
      id: 'explain-selection',
      name: 'Explicar selección',
      editorCallback: (editor) => this.runEditorAction(editor, 'explain')
    });

    this.addCommand({
      id: 'improve-selection',
      name: 'Mejorar redacción de la selección (reemplaza)',
      editorCallback: (editor) => this.runEditorAction(editor, 'improve')
    });

    this.addCommand({
      id: 'continue-writing',
      name: 'Continuar escribiendo desde el cursor',
      editorCallback: (editor) => this.runEditorAction(editor, 'continue')
    });

    this.addCommand({
      id: 'ask-about-selection',
      name: 'Preguntar a la IA sobre la selección',
      editorCallback: async (editor) => {
        const sel = editor.getSelection();
        const view = await this.activateView();
        if (view && typeof view.setInput === 'function') {
          if (sel) {
            const quoted = sel
              .split('\n')
              .map(function (l) {
                return '> ' + l;
              })
              .join('\n');
            view.setInput(
              'Sobre este texto de la nota:\n' + quoted + '\n\nMi pregunta: '
            );
          } else {
            view.setInput('Mi pregunta: ');
          }
        }
      }
    });

    /* Indexación inicial en segundo plano. */
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.ragAutoIndex) {
        window.setTimeout(() => {
          this.rebuildIndex(false, null).catch(function () {});
        }, 2500);
      }
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  client() {
    return new FreeLLMAClient(this.settings);
  }

  /* ----------------------- RAG ----------------------- */

  async rebuildIndex(notify, infoFn) {
    if (infoFn) infoFn('📚 Indexando notas…');
    const st = await this.index.rebuildAll();
    if (infoFn) {
      infoFn(
        '📚 Índice listo: ' + st.files + ' notas · ' + st.chunks + ' fragmentos.',
        6000
      );
    }
    if (notify) {
      new Notice(
        '📚 Índice de notas: ' + st.files + ' notas, ' + st.chunks + ' fragmentos.'
      );
    }
    return st;
  }

  /** Recupera los fragmentos relevantes para una pregunta (construye el índice si hace falta). */
  async getRagResults(question, infoFn) {
    if (!this.index.builtOnce) {
      if (infoFn) {
        infoFn(
          '📚 Construyendo el índice de tus notas… (solo la primera vez)',
          15000
        );
      }
      await this.rebuildIndex(false, infoFn);
    }
    return this.index.search(question, Number(this.settings.ragTopK) || 4);
  }

  buildRagPrompt(question, results) {
    const template =
      this.settings.ragTemplate && this.settings.ragTemplate.trim()
        ? this.settings.ragTemplate
        : DEFAULT_RAG_TEMPLATE;
    const ctx = results
      .map(function (r, i) {
        return (
          '[' +
          (i + 1) +
          '] Nota: «' +
          basenameNoExt(r.path) +
          '»' +
          (r.section ? ' — ' + r.section : '') +
          '\n' +
          r.text.slice(0, 2000)
        );
      })
      .join('\n\n');
    return template
      .replace(/\{\{contexto\}\}/g, ctx)
      .replace(/\{\{pregunta\}\}/g, question);
  }

  /* ----------------------- vistas ----------------------- */

  getChatView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (leaves.length && leaves[0].view) return leaves[0].view;
    return null;
  }

  async activateView() {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    let leaf;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_CHAT,
        active: true
      });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  refreshChatView() {
    const view = this.getChatView();
    if (view && typeof view.renderHistory === 'function') {
      view.renderHistory();
    }
  }

  syncChatView() {
    const view = this.getChatView();
    if (view && typeof view.fillModelSelect === 'function') {
      view.fillModelSelect();
    }
    if (view && typeof view.syncRagToggle === 'function') {
      view.syncRagToggle();
    }
  }

  /** Acciones sobre el editor: resumir / explicar / mejorar / continuar. */
  async runEditorAction(editor, kind) {
    const selection = editor.getSelection();
    const activeFile = this.app.workspace.getActiveFile();
    const noteName = (activeFile && activeFile.basename) || 'nota';

    let userMsg = '';
    let mode = 'insert'; // 'insert' debajo del cursor/selección | 'replace' sustituye la selección

    if (kind === 'summarize') {
      if (!selection) {
        new Notice('Selecciona primero el texto que quieres resumir.');
        return;
      }
      userMsg =
        'Resume el siguiente texto de la nota «' +
        noteName +
        '». Devuelve solo el resumen, en Markdown, en el idioma original:\n\n---\n' +
        selection +
        '\n---';
    } else if (kind === 'explain') {
      if (!selection) {
        new Notice('Selecciona primero el texto que quieres explicar.');
        return;
      }
      userMsg =
        'Explica de forma clara y sencilla el siguiente texto, en su mismo idioma. ' +
        'Devuelve solo la explicación:\n\n---\n' +
        selection +
        '\n---';
    } else if (kind === 'improve') {
      if (!selection) {
        new Notice('Selecciona primero el texto que quieres mejorar.');
        return;
      }
      mode = 'replace';
      userMsg =
        'Mejora la redacción del siguiente texto manteniendo el idioma, el tono y el ' +
        'significado. Devuelve únicamente el texto mejorado, sin comentarios ni comillas:\n\n---\n' +
        selection +
        '\n---';
    } else if (kind === 'continue') {
      const tail = editor.getValue().slice(-6000);
      userMsg =
        'Continúa la escritura de esta nota de forma natural y coherente, en el mismo ' +
        'idioma y estilo. Devuelve solo la continuación (2-3 párrafos), sin repetir el ' +
        'texto existente y sin comentarios.\n\nTítulo de la nota: ' +
        noteName +
        '\n\nContenido actual (parte final):\n---\n' +
        tail +
        '\n---';
    }

    new Notice('FreeLLMAPI está generando…');

    const messages = [];
    if (this.settings.systemPrompt && this.settings.systemPrompt.trim()) {
      messages.push({
        role: 'system',
        content: this.settings.systemPrompt.trim()
      });
    }
    messages.push({ role: 'user', content: userMsg });

    try {
      const out = await this.client().chat(messages);
      if (!out) return;
      if (mode === 'replace') {
        editor.replaceSelection(out);
      } else {
        const end = editor.getCursor('to');
        editor.setCursor(end);
        editor.replaceSelection('\n\n' + out + '\n');
      }
      new Notice('✅ Listo.');
    } catch (err) {
      new Notice('Error de FreeLLMAPI: ' + (err.message || err), 10000);
    }
  }
}

module.exports = FreeLLMAPIPlugin;
