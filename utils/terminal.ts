export class TerminalDisplay {
  private firstRun = true;
  private lineCount: number = 0;

  update(lines: string[]) {
    const moveUp = this.firstRun ? "" : `\x1b[${this.lineCount}A`;
    const output = lines.map((line) => `\x1b[K${line}`).join("\n");
    process.stdout.write(moveUp + output + "\n");
    this.lineCount = lines.length;
    if (this.firstRun) this.firstRun = false;
  }
}

export type TerminalColor = "green" | "yellow" | "red" | "cyan" | "dim";

type TerminalDashboardOptions = {
  isTTY?: boolean;
  rows?: number;
  write?: (chunk: string) => void;
};

const ANSI: Record<TerminalColor, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const RESET = "\x1b[0m";

export class TerminalDashboard {
  private dashboardLines: string[] = [];
  private logLines: string[] = [];
  private readonly isTTY: boolean;
  private readonly rows?: number;
  private readonly write: (chunk: string) => void;

  constructor(opts: TerminalDashboardOptions = {}) {
    this.isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
    this.rows = opts.rows;
    this.write = opts.write ?? ((chunk) => process.stdout.write(chunk));
  }

  update(lines: string[]): void {
    this.dashboardLines = lines;
    if (this.isTTY) this.repaint();
  }

  log(line: string, color?: TerminalColor): void {
    const output = color ? `${ANSI[color]}${line}${RESET}` : line;
    if (!this.isTTY) {
      this.write(output + "\n");
      return;
    }

    this.logLines.push(output);
    this.repaint();
  }

  private repaint(): void {
    const rows = this.rows ?? process.stdout.rows ?? 40;
    const maxLogs = Math.max(0, rows - this.dashboardLines.length - 2);
    const visibleLogs = this.logLines.slice(-maxLogs);
    const output = [...this.dashboardLines, "", ...visibleLogs].join("\n");
    this.write(`\x1b[H\x1b[J${output}\n`);
  }
}
