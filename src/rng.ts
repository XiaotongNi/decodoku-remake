export class SeededRng {
  private state: number;

  constructor(seed: string | number) {
    this.state = SeededRng.hashSeed(seed);
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer");
    }
    return Math.floor(this.next() * maxExclusive);
  }

  range(minInclusive: number, maxInclusive: number): number {
    if (
      !Number.isInteger(minInclusive) ||
      !Number.isInteger(maxInclusive) ||
      minInclusive > maxInclusive
    ) {
      throw new Error("invalid integer range");
    }
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  private static hashSeed(seed: string | number): number {
    const text = String(seed);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0 || 0x9e3779b9;
  }
}
