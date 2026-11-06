import { call } from "../core";
import type { Area, Note, NoteQuery, NoteSummary, Vault } from "./types";

const load = () => import("./mock");

export const listVaults = (): Promise<Vault[]> =>
  call("list_vaults", {}, async () => (await load()).listVaults());
export const listAreas = (): Promise<Area[]> =>
  call("list_areas", {}, async () => (await load()).listAreas());
export const listNotes = (query: NoteQuery): Promise<NoteSummary[]> =>
  call("list_notes", { query }, async () => (await load()).listNotes(query));
export const getNote = (domain: string, key: string): Promise<Note> =>
  call("get_note", { domain, key }, async () => (await load()).getNote(domain, key));
