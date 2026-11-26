// The threads a track holds, in their order.

import type { PlaceRec, Tx } from "../tx.js";

export const placesOf = (tx: Tx, trackId: string): PlaceRec[] => tx.sql.exec<PlaceRec>("SELECT * FROM place WHERE track_id = ? ORDER BY position, session_id", trackId);
