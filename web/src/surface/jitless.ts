import { z } from 'zod'

// The desktop app's CSP allows no eval. zod (the SDK's schemas) then parses
// without compiling, and does not probe `new Function` when a schema is
// built, which the CSP would report. Imported first by the desktop entry.
z.config({ jitless: true })
