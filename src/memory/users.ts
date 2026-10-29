import { readFileSync } from "node:fs";
import type { Db } from "../db.ts";
import { formatDate } from "../text.ts";
import type { Memory } from "./long-term.ts";

/** Perfil estruturado do colaborador — a "memória institucional" que vem do sistema de RH (aqui, de um seed). */
export interface UserProfile {
  id: string;
  name: string;
  role: string;
  team: string;
  contract: string;
  workModel: string;
  startDate: string;
  city: string;
}

export function seedUsers(db: Db, file: string): number {
  const users = JSON.parse(readFileSync(file, "utf8")) as UserProfile[];
  const upsert = db.prepare(`INSERT INTO users (id, name, role, team, contract, work_model, start_date, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, team = excluded.team, contract = excluded.contract,
      work_model = excluded.work_model, start_date = excluded.start_date, city = excluded.city`);
  for (const u of users) upsert.run(u.id, u.name, u.role, u.team, u.contract, u.workModel, u.startDate, u.city);
  return users.length;
}

type UserRow = { id: string; name: string; role: string; team: string; contract: string; work_model: string; start_date: string; city: string };

const fromRow = (r: UserRow): UserProfile => ({
  id: r.id, name: r.name, role: r.role, team: r.team, contract: r.contract, workModel: r.work_model, startDate: r.start_date, city: r.city
});

export function getUser(db: Db, id: string): UserProfile | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row && fromRow(row);
}

export function listUsers(db: Db): UserProfile[] {
  return (db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[]).map(fromRow);
}

export const firstName = (user: UserProfile): string => user.name.split(" ")[0]!;

/**
 * Fatos do perfil em linguagem natural (entram no módulo <perfil> e servem de "fonte" para o LLM).
 * Uma memória com a chave do campo (ex.: perfil.modelo_trabalho) prevalece sobre o cadastro do RH,
 * mas o valor original continua visível — o assistente sabe o que mudou e quando.
 */
export function profileFacts(user: UserProfile, memories: Memory[], now: Date): string[] {
  const override = (key: string) => memories.find((m) => m.key === key && m.status === "active");
  const days = Math.floor((now.getTime() - Date.parse(user.startDate)) / 86_400_000);
  const contract = user.contract === "estágio" ? "estagiário (contrato de estágio)" : `${user.contract}`;
  const workModel = override("perfil.modelo_trabalho");
  const nickname = override("preferencia.nome");
  return [
    `Nome: ${user.name}${nickname ? ` (prefere ser chamado(a) de ${nickname.content.match(/de (.+)\.$/)?.[1] ?? firstName(user)})` : ""}`,
    `Cargo: ${user.role}, time ${user.team}, ${user.city}`,
    `Vínculo: ${contract}`,
    workModel
      ? `Modelo de trabalho: ${workModel.content.replace(/^.*?modelo /, "").replace(/ \(.*$/, "").replace(/\.$/, "")} (informado pelo colaborador em ${formatDate(new Date(workModel.createdAt))}; cadastro do RH: ${user.workModel})`
      : `Modelo de trabalho: ${user.workModel}`,
    `Admissão: ${formatDate(new Date(user.startDate))} (${days} dias de casa${days <= 90 ? ", em período de experiência e onboarding" : ""})`
  ];
}
