# FreeLLMAPI Connector para Obsidian

Complemento (plugin) no oficial que conecta tu bóveda de **Obsidian** con **[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)**, el router auto-alojado que agrupa los niveles gratuitos de decenas de proveedores de LLM (Google AI Studio, Groq, Cerebras, NVIDIA, Mistral, OpenRouter, Cohere, Cloudflare, Z.ai, Ollama, HuggingFace…) detrás de un único endpoint **compatible con OpenAI**.

## Novedades v1.1.0

- 🐛 **Corregido**: `this.plugin.saveSettings is not a function` — el complemento ahora define su propio `saveSettings()` (patrón del plugin oficial de ejemplo) y ya no depende del método de la clase base `Plugin`.
- 📚 **Nuevo: RAG (búsqueda + contexto de tus notas)** — el asistente puede buscar en tu bóveda y usar las notas más relevantes como contexto, citando las fuentes.

## Funciones

- 💬 **Chat en la barra lateral** con streaming, selector de modelos, *Copiar* / *Insertar en nota* y botón de detener.
- 📚 **RAG sobre tu bóveda**:
  - Índice de palabras clave (BM25) **en memoria**, sin dependencias ni servicios externos.
  - Troceado inteligente por secciones (respeta la jerarquía de encabezados).
  - Actualización incremental al editar, crear, renombrar o borrar notas.
  - Respuestas con citas `[1]`, `[2]` y bloque de **Fuentes** con enlaces `[[wiki]]`.
- 🔎 **Comandos RAG**: *Preguntar a mis notas (RAG)…*, *Buscar en mis notas…*, *Reconstruir índice*.
- 📝 **Comandos del editor**: Resumir · Explicar · Mejorar redacción · Continuar escribiendo · Preguntar sobre la selección.
- ⚙️ **Ajustes completos**: URL base, clave unificada, modelo, temperatura, tokens, system prompt, streaming, timeout, y ajustes propios del RAG (top-K, tamaño de fragmento, carpetas excluidas, plantilla del prompt…).
- 🛟 *Fallback* automático sin streaming (vía `requestUrl`) si el navegador bloquea el stream.
- 🔒 **Privacidad**: el índice vive solo en memoria (nunca se escribe en disco); el historial se guarda en tu bóveda (`data.json`); el contexto de tus notas se envía únicamente a **tu** servidor FreeLLMAPI.

---

## 1. Requisito previo: tener FreeLLMAPI en marcha

**Opción A — Docker (una línea):**

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

**Opción B — Manual (Node.js 20+):**

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
npm run dev          # servidor en :3001, panel en :5173
```

Después:

1. Abre `http://localhost:3001` y añade tus claves de proveedores en la página **Keys**.
2. Copia tu **clave unificada** (unified key) de esa misma página.
3. El endpoint para clientes es `http://localhost:3001/v1`.

## 2. Instalar el complemento en Obsidian

> Si ya tenías la v1.0 instalada: sustituye `main.js`, `manifest.json` y `styles.css` por los nuevos y **reinicia Obsidian** (o desactiva/activa el complemento). Tus ajustes e historial se conservan.

1. Descarga el zip `freellmapi-obsidian-plugin.zip` y extrae `main.js`, `manifest.json` y `styles.css` en:

   ```text
   <tu-bóveda>/.obsidian/plugins/freellmapi-connector/
   ```

   > 💡 La carpeta `.obsidian` está oculta: en Windows activa "Elementos ocultos"; en macOS `Cmd+Shift+.`
2. Obsidian → **Ajustes (⚙) → Complementos comunitarios** → desactiva el **modo restringido** si te lo pide.
3. Activa **FreeLLMAPI Connector** y pulsa el icono 🤖 de la barra lateral.

> **Alternativa:** sube la carpeta a un repo de GitHub e instala/actualiza con [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## 3. Configuración

1. Ajustes ⚙ → **FreeLLMAPI Connector**.
2. **URL base**: `http://localhost:3001/v1` · **Clave**: tu *unified key*.
3. Pulsa **Probar conexión y cargar modelos** → "✅ Conexión correcta — N modelos".
4. (Opcional) Revisa la sección **RAG — contexto de tus notas**: top-K de fragmentos, tamaño de fragmento, carpetas excluidas, auto-indexado al iniciar y plantilla del prompt (`{{contexto}}` / `{{pregunta}}`).

## 4. Uso del RAG (búsqueda + contexto)

**Cómo funciona:** al enviar un mensaje con RAG activo, el complemento busca en un índice BM25 de tu bóveda, toma los *top-K* fragmentos más relevantes y los inyecta en el prompt como contexto numerado. El responde citando `[1]`, `[2]`… y debajo se añade un bloque **📌 Fuentes** con enlaces a las notas.

| Acción | Cómo |
|---|---|
| Activar/desactivar RAG en el chat | Botón **📚** de la cabecera del chat (queda resaltado cuando está activo) |
| Preguntar directamente a tus notas | `Ctrl/Cmd+P` → **"FreeLLMAPI: Preguntar a mis notas (RAG)…"** |
| Buscar en el índice (sin LLM) | `Ctrl/Cmd+P` → **"FreeLLMAPI: Buscar en mis notas…"** → clic en un resultado para abrir la nota |
| Reconstruir el índice | `Ctrl/Cmd+P` → **"FreeLLMAPI: Reconstruir índice de notas"** (o el botón en Ajustes → *Estado del índice*) |
| Ver qué contexto se usó | Línea informativa sobre el cuadro de entrada: "📚 Contexto: N fragmento(s) de M nota(s)" |

**Detalles útiles:**

- El índice se construye solo al arrancar (configurable) y se actualiza en segundo plano cuando editas notas.
- La primera vez que se usa el RAG, si el índice no existe, se construye en ese momento (bóvedas grandes: unos segundos).
- Excluye carpetas privadas o plantillas en Ajustes → **Carpetas excluidas** (p. ej. `plantillas, diario/privado`).
- El RAG es de recuperación por palabras clave (BM25): funciona muy bien para nombres propios, términos técnicos y títulos; no entiende sinónimos como una búsqueda semántica con embeddings.

## 5. Uso diario del chat

| Acción | Cómo |
|---|---|
| Abrir el chat | Icono 🤖 o comando **"FreeLLMAPI: Abrir chat"** |
| Enviar / saltar línea | `Enter` / `Shift+Enter` |
| Detener generación | Botón **⏹ Detener** |
| Reusar una respuesta | **Copiar** / **Insertar en nota** (aparecen al pasar el ratón) |
| Resumir / explicar / mejorar | Selecciona texto → comando correspondiente |

## 6. Solución de problemas

| Problema | Causa probable / solución |
|---|---|
| `saveSettings is not a function` | **Corregido en v1.1.0** — actualiza `main.js` y reinicia Obsidian. |
| `No se pudo conectar…` | Servidor apagado o URL/IP/puerto incorrectos. Prueba `http://localhost:3001/v1` en el navegador. |
| `HTTP 401/403` | Clave unificada ausente o incorrecta (página **Keys** del panel). |
| El RAG no encuentra nada | ¿Se construyó el índice? Mira Ajustes → *Estado del índice*, o ejecuta *Reconstruir índice de notas*. Revisa las carpetas excluidas y el límite de KB por nota. |
| Respuestas genéricas (ignora tus notas) | Sube *Fragmentos de contexto (top-K)*; verifica que el término buscado aparezca tal cual en las notas (índice por palabras clave). |
| Uso desde el móvil | `localhost` no existe en el teléfono: apunta la URL a la IP del equipo donde corre el servidor (misma red). El índice se reconstruye en cada dispositivo. |

## 7. Cómo está hecho

- JavaScript puro (CommonJS), **sin paso de compilación** ni dependencias: `main.js` + `manifest.json` + `styles.css`.
- Endpoints: `POST /v1/chat/completions` (SSE + fallback `requestUrl`) y `GET /v1/models`.
- RAG: índice invertido con BM25 (`k1=1.2, b=0.75`) en memoria; troceado por párrafos/secciones con solapamiento; eventos `modify`/`delete`/`rename` de la bóveda para actualizaciones incrementales (con *debounce*).
- Licencia: MIT.

> ⚠️ FreeLLMAPI está pensado para **experimentación personal**: respeta los términos de cada proveedor y no lo uses en producción.

### Historial de versiones

- **1.1.0** — Corrige `saveSettings is not a function`; añade RAG (índice BM25 de la bóveda, chat con contexto y fuentes, modales de pregunta/búsqueda, ajustes y actualización incremental).
- **1.0.0** — Versión inicial: chat lateral, comandos del editor y ajustes.
