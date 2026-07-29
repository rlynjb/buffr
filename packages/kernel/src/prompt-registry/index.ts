export type PromptEntry = { name: string; version: string; template: string };

export class PromptRegistry {
  private readonly store = new Map<string, PromptEntry>(); // `name@version` → entry
  private readonly latest = new Map<string, string>(); // name → latest version

  register(name: string, version: string, template: string): void {
    this.store.set(`${name}@${version}`, { name, version, template });
    this.latest.set(name, version);
  }

  get(name: string, version?: string): PromptEntry {
    const v = version ?? this.latest.get(name);
    if (v === undefined) throw new Error(`No prompt registered for "${name}"`);
    const entry = this.store.get(`${name}@${v}`);
    if (!entry) throw new Error(`No prompt registered for "${name}@${v}"`);
    return entry;
  }

  has(name: string, version?: string): boolean {
    const v = version ?? this.latest.get(name);
    if (v === undefined) return false;
    return this.store.has(`${name}@${v}`);
  }

  list(): PromptEntry[] {
    return [...this.store.values()];
  }
}
