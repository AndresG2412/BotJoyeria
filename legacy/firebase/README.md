# Código legado de Firebase (Firestore)

Esta carpeta conserva el código original que usaba **Firebase / Firestore** antes de la
migración a **Supabase** (Postgres + Storage). No se compila ni se usa en producción;
queda solo como referencia histórica por si necesitas revisar cómo funcionaba antes.

## Contenido

| Archivo | Era antes |
|---|---|
| `firebase.ts` | `src/config/firebase.ts` — inicialización de firebase-admin con `firebase-key.json` |
| `catalog.firestore.ts` | `src/data/catalog.ts` — productos/categorías/filtros sobre las colecciones `Propiedades` y `Categorias` de Firestore |
| `database.firestore.ts` | `src/data/database.ts` — sesiones de chat y citas sobre las colecciones `sessions` y `appointments` de Firestore |
| `env.example.firebase.txt` | `.env.example` original con las instrucciones de Firebase |

## Notas

- El archivo `firebase-key.json` de la raíz **sigue en uso** únicamente para la API de
  Google Calendar (agendamiento de citas en `src/bot/tools.ts`), porque esa API también
  usa una cuenta de servicio de Google. Ya no se usa para Firestore.
- La dependencia `firebase-admin` sigue en `package.json` solo para que este código de
  referencia siga siendo compilable si se restaura. Puedes desinstalarla si no la necesitas.
