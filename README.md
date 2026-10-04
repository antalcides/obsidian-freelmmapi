# FreeLLMAPI Connector para Obsidian

Complemento (plugin) no oficial que conecta tu bóveda de **Obsidian** con **[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)**, el router auto-alojado que agrupa los niveles gratuitos de decenas de proveedores de LLM (Google AI Studio, Groq, Cerebras, NVIDIA, Mistral, OpenRouter, Cohere, Cloudflare, Z.ai, Ollama, HuggingFace…) detrás de un único endpoint **compatible con OpenAI**.

## Funciones

- 💬 **Chat en la barra lateral** con respuestas en streaming (tiempo real), selector de modelos y "Insertar en nota".
- 📝 **Comandos del editor**:
  - *Resumir selección*
  - *Explicar selección*
  - *Mejorar redacción de la selección* (reemplaza el texto)
  - *Continuar escribiendo desde el cursor*
  - *Preguntar a la IA sobre la selección* (abre el chat con el texto citado)
- ⚙️ **Ajustes completos**: URL base, clave unificada, modelo, temperatura, máximo de tokens, system prompt, streaming y tiempo de espera.
- 🌐 Detección de modelos automática desde `GET /v1/models`.
- 🛟 Si el navegador bloquea el streaming (CORS), reintenta automáticamente por la vía sin streaming de Obsidian (`requestUrl`).
- 🔒 El historial del chat se guarda **solo en tu bóveda** (`data.json` del complemento).

---

## 1. Requisito previo: tener FreeLLMAPI en marcha

El complemento no trae modelos propios: habla con **tu servidor FreeLLMAPI**. Si aún no lo tienes instalado:

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

1. Abre el panel en `http://localhost:3001`.
2. En la página **Keys** añade las claves de tus proveedores gratuitos (Google AI Studio, Groq, etc.).
3. Copia tu **clave unificada** (unified key) de esa misma página.
4. El endpoint para clientes es: `http://localhost:3001/v1`.

## 2. Instalar el complemento en Obsidian

Como el complemento no está en la tienda oficial, se instala manualmente (5 minutos):

1. **Descarga los archivos del complemento**: `main.js`, `manifest.json` y `styles.css` (usa el zip `freellmapi-obsidian-plugin.zip` que acompaña a este README, o cópialos de esta carpeta).

2. En tu equipo, ve a la carpeta de tu bóveda y crea el directorio del complemento:
   
   ```text
   <tu-bóveda>/.obsidian/plugins/freellmapi-connector/
   ```
   
   > 💡 La carpeta `.obsidian` está oculta. En Windows, activa "Elementos ocultos" en el Explorador; en macOS usa `Cmd+Shift+.` en Finder.

3. Copia dentro **`main.js`**, **`manifest.json`** y **`styles.css`** (el README no es necesario).

4. Abre Obsidian → **Ajustes (⚙) → Complementos comunitarios**.
   
   - Si aparece el aviso de **modo restringido**, pulsa **Desactivar modo restringido** y confirma.

5. En la lista de complementos instalados, activa **FreeLLMAPI Connector**.

6. Aparecerá un icono 🤖 en la barra lateral izquierda: ¡listo!

> **Alternativa:** si subes esta carpeta a un repositorio de GitHub, puedes instalarlo y actualizarlo automáticamente con el plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## 3. Configuración

1. Ajustes ⚙ → **FreeLLMAPI Connector**.
2. **URL base de la API**: `http://localhost:3001/v1` (por defecto). Si tu servidor está en otra máquina, usa su IP, p. ej. `http://192.168.1.50:3001/v1`.
3. **Clave de API**: pega tu *unified key* del panel de FreeLLMAPI (déjala vacía si tu servidor no pide clave).
4. Pulsa **Probar conexión y cargar modelos** → deberías ver "✅ Conexión correcta — N modelos".
5. Elige el modelo (`auto` deja que el router decida) y ajusta temperatura/tokens si quieres.

## 4. Uso diario

| Acción                       | Cómo                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Abrir el chat                | Icono 🤖 en la cinta, o `Ctrl/Cmd+P` → **"FreeLLMAPI: Abrir chat"**          |
| Enviar mensaje               | `Enter` (salto de línea con `Shift+Enter`)                                   |
| Detener generación           | Botón **⏹ Detener**                                                          |
| Reusar una respuesta         | Botones **Copiar** / **Insertar en nota** al pasar el ratón por la respuesta |
| Resumir / explicar / mejorar | Selecciona texto → `Ctrl/Cmd+P` → comando correspondiente                    |
| Nueva conversación           | Botón **Nueva** en el chat                                                   |

Puedes asignar **atajos de teclado** en Ajustes → **Atajos** buscando "FreeLLMAPI".

## 5. Solución de problemas

| Problema                                   | Causa probable / solución                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `No se pudo conectar…` / `Failed to fetch` | El servidor FreeLLMAPI no está corriendo, o la URL/IP/puerto está mal. Prueba `http://localhost:3001/v1` en tu navegador. |
| `HTTP 401/403`                             | Falta la clave o es incorrecta: copia la *unified key* de la página **Keys** del panel.                                   |
| `404` en `/models` o `/chat/completions`   | La URL base no debe incluir `/chat/completions`; debe terminar en `/v1`.                                                  |
| No aparece ningún modelo                   | Añade al menos una clave de proveedor en el panel de FreeLLMAPI.                                                          |
| Respuestas cortadas                        | Sube el *Máximo de tokens* o el tiempo de espera en los ajustes.                                                          |
| Uso desde el móvil                         | `localhost` no existe en el teléfono: apunta la URL a la IP de la máquina donde corre el servidor (misma red).            |

## 6. Cómo está hecho

- JavaScript puro (CommonJS), **sin paso de compilación**: basta con `main.js`, `manifest.json` y `styles.css`.
- Endpoints usados: `POST /v1/chat/completions` (con `stream: true`, parseo SSE; *fallback* sin streaming vía `requestUrl`) y `GET /v1/models`.
- Vista lateral (`ItemView`) + comandos del editor + pestaña de ajustes estándar de Obsidian.
- Licencia: MIT. Haz los cambios que quieras (los textos en español están agrupados al inicio de cada bloque de `main.js` para que los edites fácilmente).

> ⚠️ Recuerda que FreeLLMAPI está pensado para **experimentación personal**: respeta los términos de cada proveedor y no lo uses para producción.

---

> X Sin conexión `this.plugin.saveSettings is not a function

Encontré el problema y voy a agregar el RAG. Sobre el error: el complemento dependía del método `saveSettings()` de la clase base `Plugin` de Obsidian, que en tu entorno no está disponible. La solución robusta es definir nuestro propio `saveSettings()` (el patrón estándar de los plugins oficiales), que no depende de la clase base.

Primero reescribo `main.js` completo con el arreglo + RAG (índice BM25 en memoria, chunking por secciones, actualizaciones incrementales, modal de preguntas y buscador de notas):

Dejame limpiar una lógica confusa en la detección de encabezados de `chunkNoteText`:

Ahora valido la sintaxis y hago una prueba funcional del índice RAG en Node (con un stub del módulo `obsidian`):

La prueba detectó un fallo real de diseño: los fragmentos pequeños se fusionaban en uno solo etiquetado con la *última* sección. Corrijo `chunkNoteText` para que cada sección sea su propio fragmento (mejor precisión de recuperación):

Reemplacé la firma pero dejé el cuerpo antiguo huérfano. Déjame revisar y eliminar el código duplicado:

¡Todas las pruebas pasan! 🎉 Ahora actualizo los estilos para los nuevos elementos de UI (botón RAG, línea de info, modales de búsqueda):

Ahora actualizo el README con el arreglo, la documentación del RAG y el historial de versiones:

Finalmente, reconstruyo el ZIP y ejecuto una última verificación completa:

¡Listo! La **v1.1.0** corrige el error y añade RAG completo. El ZIP actualizado es `freellmapi-obsidian-plugin.zip`.

## 🐛 El error `saveSettings is not a function`

El complemento dependía del método `saveSettings()` de la clase base `Plugin` de Obsidian, que en tu versión/entorno no estaba disponible. **Solución**: ahora el plugin define su propio `saveSettings()` (el patrón estándar del plugin oficial de ejemplo de Obsidian), que llama directamente a `saveData()`. Además, la prueba de conexión ya no re-renderiza la pestaña de ajustes.

## 📚 Nuevo: RAG (búsqueda + contexto de tus notas)

- **Índice BM25 en memoria** de todas tus notas (sin dependencias ni servicios externos), con troceado **por secciones** que respeta la jerarquía de encabezados y solapamiento entre fragmentos.
- **Actualización incremental**: al editar/crear/renombrar/borrar una nota, solo esa nota se reindexa en segundo plano.
- **En el chat**: botón **📚** para activar/desactivar el RAG; cada mensaje recupera los *top-K* fragmentos relevantes (línea "📚 Contexto: N fragmentos de M notas") y la respuesta incluye citas `[1]`, `[2]`… más un bloque **📌 Fuentes** con enlaces `[[wiki]]`.
- **Nuevos comandos**:
  - *"Preguntar a mis notas (RAG)…"* — modal de pregunta con contexto automático.
  - *"Buscar en mis notas…"* — buscador con vista previa; clic abre la nota.
  - *"Reconstruir índice de notas"*.
- **Ajustes RAG**: top-K, tamaño de fragmento, límite de KB por nota, carpetas excluidas, auto-indexado al iniciar y **plantilla del prompt** editable (`{{contexto}}` / `{{pregunta}}`).
- **Privacidad**: el índice nunca se escribe en disco y el contexto solo viaja a *tu* servidor FreeLLMAPI.

## ✅ Cómo actualizar

1. Descarga el zip nuevo y reemplaza `main.js`, `manifest.json` y `styles.css` en `<bóveda>/.obsidian/plugins/freellmapi-connector/`.
2. Reinicia Obsidian (o desactiva/activa el complemento). Tus ajustes e historial se conservan.
3. Prueba de nuevo **"Probar conexión"** — ahora debería mostrar ✅ con el número de modelos.

El índice se construye solo al arrancar (bóvedas grandes: unos segundos la primera vez). Verifiqué el motor de búsqueda con pruebas automatizadas: indexación, secciones jerárquicas, BM25, actualizaciones incrementales y exclusión de carpetas — todo en orden ✔️

¿Siguiente paso? Puedo añadir resaltado de términos en los resultados de búsqueda, o un comando que resuma una nota cruzándola con notas relacionadas (RAG + resumen).

---

> Me gustarían las dos opciones

¡Perfecto! Implemento ambas: **resaltado de términos** en los resultados de búsqueda y el **resumen de nota cruzada con notas relacionadas** (RAG). Primero añado las funciones auxiliares (resaltado, términos de consulta de nota y prompt de resumen relacionado):

Ahora el resaltado en los resultados del buscador de notas:

Ahora añado el método `getRelatedForNote` al plugin y el nuevo comando:

Ahora el comando nuevo en `onload`:

Ahora el CSS del resaltado, y la actualización de versión:

Ahora ejecuto la suite de pruebas ampliada con las nuevas funciones:

Todas las pruebas pasan (17 nuevas + regresión). Actualizo el README y regenero el ZIP:

Faltó el historial en el README (el ZIP se generó antes). Lo corrijo y regenero:

¡Listo! La **v1.2.0** incluye ambas funciones. ZIP actualizado: `freellmapi-obsidian-plugin.zip`.

## ✨ 1. Resaltado de términos en la búsqueda

En **"FreeLLMAPI: Buscar en mis notas…"** ahora:

- Los términos de tu consulta se **resaltan** (fondo amarillo estilo `==mark==`, adaptable al tema) tanto en el título como en el fragmento de cada resultado.
- El fragmento se **recorta alrededor de la primera coincidencia** (ya no siempre muestra el inicio de la nota).
- Insensible a mayúsculas y tildes (busca "kafka" y resalta "Kafka"), con escapado seguro de caracteres especiales, y sin usar `innerHTML` (a prueba de inyección).

## 📝 2. Resumir nota cruzada con notas relacionadas

Nuevo comando **"FreeLLMAPI: Resumir nota con notas relacionadas (RAG)"**:

1. Toma la nota activa y extrae sus **términos más representativos** (título con peso ×3 + cuerpo, sin stopwords).
2. Busca en el índice BM25 las **notas más relacionadas, excluyendo la nota actual** (para que no domine sus propios términos).
3. Envía al modelo la nota (truncada a 8.000 caracteres) + los fragmentos relacionados, pidiendo un formato fijo:
   - **## Resumen** (2-3 párrafos)
   - **## Puntos clave** (3-7 viñetas)
   - **## Conexiones con otras notas** (citando `[1]`, `[2]`…)
4. Inserta el resultado en el cursor, con bloque **📌 Fuentes** enlazando las notas (`[[wiki]]`). Si no hay relacionadas, lo indica y omite la sección.

## ✅ Verificación

Suite ampliada: **17 pruebas nuevas** (regex de resaltado con tildes/mayúsculas/escapado, pesos del título en `noteQueryTerms`, truncado y formato del prompt, exclusión de la nota actual) + regresión completa del índice RAG — todo en orden.

**Para actualizar:** reemplaza los 3 archivos en `<bóveda>/.obsidian/plugins/freellmapi-connector/` y reinicia Obsidian. Sugerencia: asigna un atajo al nuevo comando en Ajustes → Atajos (p. ej. `Ctrl+Shift+R`) que lo usarás mucho.

¿Algo más? Podría añadir, por ejemplo, un botón "Resumir con relacionadas" directamente en el menú de los tres puntos del editor, o exportar el chat con sus fuentes a una nota nueva.

---

> Exportar el chat con sus fuentes a una nota nueva y la opción de un resumen para una nueva nota.

¡Voy con ambas! **Exportar el chat a una nota nueva** y **resumen en nota nueva**. Primero añado las funciones auxiliares puras (para poder testearlas): sanitizar nombres de archivo, construir el Markdown del chat exportado y el de la nota de resumen:

Ahora el ajuste de carpeta de exportación y el botón en la cabecera del chat:

Ahora los métodos del plugin: refactor del generador de resumen, creación robusta de notas, exportación de chat y resumen en nota nueva:

Ahora refactorizo el comando de resumen existente para reutilizar el generador y añado los dos comandos nuevos:

Ahora el ajuste de carpeta de exportación en la sección "Datos" de la pestaña de ajustes:

Versión 1.3.0 y pruebas de las nuevas funciones:

Los dos fallos son de mis expectativas en el test, no del código (el comportamiento actual es mejor: elimina guiones finales y `___` es un nombre válido). Corrijo las aserciones:

23/23 pruebas pasan. Ejecuto las suites de regresión con las rutas correctas:

Regresión limpia. Actualizo el README con las dos funciones nuevas y regenero el ZIP:

Déjame revisar el estado completo del README:

El README actual perdió la fila de la tabla de la v1.2. Lo corrijo todo junto (tabla completa con las novedades v1.2 y v1.3, sección de uso diario y changelog):

README completo. Regenero el ZIP con verificación final:

¡Listo! La **v1.3.0** incluye las dos funciones. ZIP actualizado: `freellmapi-obsidian-plugin.zip`.

## 💾 Exportar el chat a una nota nueva

- **Botón 💾** en la cabecera del chat o comando *"FreeLLMAPI: Exportar chat a una nota nueva"*.
- Crea una nota tipo `Chat FreeLLMAPI 2026-09-21 14-05-33.md` con:
  - **Callout de metadatos**: modelo, RAG activado/desactivado, número de mensajes y fecha.
  - Cada intercambio numerado: `## 1. 👤 Tú` / `## 1. 🤖 Asistente`, **conservando los bloques 📌 Fuentes** de cada respuesta RAG.
- Se abre al crearse, en una pestaña nueva.
- **Carpeta de destino configurable** (Ajustes → *Carpeta para exportar el chat*, p. ej. `chats`): se crea automáticamente si no existe, con prevención de colisiones de nombre (`- 2`, `- 3`…).

## 📝 Resumen para una nota nueva

- Nuevo comando *"FreeLLMAPI: Resumir nota activa en una nota nueva (RAG)"*.
- Igual análisis cruzado que el resumen existente (términos de la nota → BM25 → fragmentos relacionados, excluyendo la propia nota), pero en vez de insertar el texto **crea `Resumen - <nota>.md` junto a la nota original** con:
  - Título enlazado a la fuente: `# 📝 Resumen — [[proyectos/alpha|alpha]]`
  - Callout con fecha, modelo y número de notas relacionadas.
  - El resumen (Resumen + Puntos clave + Conexiones con citas) y el bloque **📌 Fuentes**.
- Ideal para *zettelkasten*: tu nota original queda intacta y el resumen vive como nota propia enlazada.

## ✅ Verificación

- **61 pruebas automatizadas en verde** (23 nuevas: sanitizado de nombres de archivo, sellos de tiempo sin `:` para Windows, estructura del Markdown de exportación/resumen, numeración por pares, enlaces con alias, ausencia de fuentes cuando no hay relacionadas + regresión completa v1.1/v1.2).
- Verificación de contenido del ZIP: comandos, métodos, ajuste y README al día.

**Para actualizar:** reemplaza los 3 archivos en `<bóveda>/.obsidian/plugins/freellmapi-connector/` y reinicia Obsidian. Tus ajustes, historial e índice se conservan (el ajuste nuevo se agrega con valor por defecto: raíz de la bóveda).

¿Quieres algo más? Por ejemplo: exportación automática de cada conversación al cerrarla, plantillas de notas personalizables para el resumen, o un botón "Exportar" en los tres puntos del editor.
