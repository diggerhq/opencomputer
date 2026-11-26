// Readers and writers of the Slack actor's small tables: settings, thread to session, Slack user to member.

import { type Sql } from "../../durable/sql.js";

export const settings = {
  get(sql: Sql, key: string): string | undefined {
    return sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)[0]?.value;
  },
  put(sql: Sql, key: string, value: string): void {
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  },
  drop(sql: Sql, key: string): void {
    sql.exec("DELETE FROM settings WHERE key = ?", key);
  },
};

export const threads = {
  sessionOf(sql: Sql, key: string): string | undefined {
    return sql.exec<{ session_id: string }>("SELECT session_id FROM thread WHERE key = ?", key)[0]?.session_id;
  },
  keyOf(sql: Sql, sessionId: string): string | undefined {
    return sql.exec<{ key: string }>("SELECT key FROM thread WHERE session_id = ?", sessionId)[0]?.key;
  },
  put(sql: Sql, key: string, sessionId: string): void {
    sql.exec("INSERT INTO thread (key, session_id) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", key, sessionId);
  },
};

export const links = {
  memberOf(sql: Sql, slackUser: string): string | undefined {
    return sql.exec<{ member: string }>("SELECT member FROM link WHERE slack_user = ?", slackUser)[0]?.member;
  },
  put(sql: Sql, slackUser: string, member: string): void {
    sql.exec("INSERT INTO link (slack_user, member) VALUES (?, ?) ON CONFLICT(slack_user) DO UPDATE SET member = excluded.member", slackUser, member);
  },
};
