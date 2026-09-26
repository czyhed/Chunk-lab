export type GenerationTicket = {
  key: string;
  revision: number;
};

export class GenerationGate {
  private readonly revisions = new Map<string, number>();

  begin(documentId: string, operation: "preview" | "context" | "vlm"): GenerationTicket {
    const key = `${documentId}:${operation}`;
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return { key, revision };
  }

  isCurrent(ticket: GenerationTicket): boolean {
    return this.revisions.get(ticket.key) === ticket.revision;
  }
}
