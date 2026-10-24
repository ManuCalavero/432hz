# cooler

App MVP para subir un archivo de audio, retunarlo manteniendo la duracion, y descargar el resultado en WAV y MP3.

Incluye:

- Cola de procesamiento secuencial (jobs en memoria).
- El estado de cada conversión se mantiene solo en memoria durante la sesión.

## Web en Vercel

La versión web convierte el audio **en el navegador** con ffmpeg.wasm: los archivos del usuario no se suben a ningún servidor.
Los links de YouTube se descargan con Apify (actor `utils~youtube-link`) a través de la función serverless `api/youtube.js`,
que es la única que conoce el token.

Variables de entorno en Vercel (Settings → Environment Variables):

- `APIFY_TOKEN` (obligatoria): token de Apify. Solo en Vercel o en `.env` local, nunca en `.env.example`.
- `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY` (obligatorias para YouTube): claves de Cloudflare Turnstile.
  Sin ellas la conversión desde YouTube queda desactivada. Las claves de prueba de Cloudflare se rechazan en producción.
- `YOUTUBE_DAILY_LIMIT` (opcional, 30 por defecto): máximo global de descargas de YouTube en 24 h.

`vercel.json` define el build (`npm run build:web`, que copia ffmpeg.wasm a `public/vendor/` y genera
`public/vendor/config.json` con la clave pública de Turnstile) y las cabeceras de seguridad (CSP).

Protecciones del endpoint `/api/youtube`:

- Anti-bots con Cloudflare Turnstile en cada descarga.
- Solo acepta links de YouTube; la URL que se envía a Apify se reconstruye a partir del ID del vídeo.
- Máximo 5 descargas de YouTube por usuario y día (contador en el almacén `432hz-limits` de Apify; solo guarda un hash de la IP),
  límite global diario y coste máximo por ejecución (0,10 $).
- Los trabajos se identifican con un token firmado (HMAC) que caduca en 1 hora.
- El audio se entrega con una URL firmada de solo lectura y se borra de Apify cuando el navegador lo ha descargado.

Analítica: Vercel Web Analytics (actívala en el panel del proyecto). El plan gratuito no tiene eventos personalizados,
así que cada resultado se registra como una visita a una ruta virtual: `/_evento/youtube-ok`, `/_evento/file-ok`,
`/_evento/youtube-error-<código>` y `/_evento/file-error-<código>`.

La web está solo en inglés. Los textos generados desde JavaScript están en `public/i18n.js`.

## Requisitos

- Node.js 18+

`ffmpeg` no se instala globalmente: la app usa `ffmpeg-static`.

## Instalacion

```bash
npm install
```

## Ejecutar

```bash
npm start
```

Abre:

- `http://localhost:3000`

## Flujo de conversion

1. El usuario arrastra o selecciona un archivo de audio.
2. Se valida el formato y la duracion del archivo.
3. Se encola un job.
4. Se aplica retune global con perfil de afinacion:

- `original`: 440 -> 440 Hz (sin transformacion de afinacion)
- `exact`: 440 -> 432 Hz

Filtro actual (alta calidad con resampler SoX):

```text
asetrate=44100*(targetA4/440),aresample=44100:resampler=soxr:precision=28:cheby=1,atempo=440/targetA4
```

5. Se exporta WAV PCM 16-bit 44.1 kHz.
6. Se exporta MP3 320 kbps 44.1 kHz.
7. El resultado se muestra durante la sesión y no se guarda ningún historial.

## API principal

- `POST /api/jobs` crea job multipart con campos `audio` y `tuningMode=original|exact`
- `GET /api/jobs/:id` consulta estado y enlaces de descarga si esta completado
- `GET /api/download/:id/wav` descarga WAV
- `GET /api/download/:id/mp3` descarga MP3
- `GET /health` estado de servicio

## Estructura

- `src/server.js`: API, estados y cola
- `src/audio.js`: descarga y conversion ffmpeg
- `src/store.js`: estado temporal de los jobs en memoria
- `public/`: interfaz web

## Notas importantes

- La cola y el estado de los jobs son temporales; al cerrar la aplicación no se conserva ningún registro.
- Este MVP asume acceso permitido a contenido de YouTube y no gestiona aspectos legales/licencias.
- Se limita la duracion maxima del audio a 60 minutos.
- No requiere instalar `ffmpeg` en el equipo del usuario final (se usa `ffmpeg-static`).
