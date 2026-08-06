-- Undo the short-lived hidden-by-default navigation state introduced in 0004.
-- A user who changed only one preference keeps that explicit choice.

UPDATE users
SET durable_sessions_enabled = 1,
    infrastructure_enabled = 1
WHERE durable_sessions_enabled = 0
  AND infrastructure_enabled = 0;
