// BrightLocal MCP client wrapper for edge functions.
// Uses BL's hosted MCP server at https://mcp.brightlocal.com/mcp via JSON-RPC over HTTP.
// Auth: x-api-key header with BRIGHTLOCAL_API_KEY env var.
//
// Maintains an MCP session via initialize → notifications/initialized → tool calls.
// Each call creates a fresh session (BL sessions are not long-lived per docs).

const MCP_URL = "https://mcp.brightlocal.com/mcp";

interface MCPResponse<T = unknown> {
  jsonrpc: string;
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseSSE(body: string): unknown {
  // BrightLocal MCP returns text/event-stream format: "event: message\ndata: {...}\n\n"
  const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) {
    try { return JSON.parse(body); } catch { return null; }
  }
  try { return JSON.parse(dataLine.slice(6)); } catch { return null; }
}

export class BrightLocalMCP {
  private apiKey: string;
  private sessionId: string | null = null;

  constructor(apiKey?: string) {
    const key = apiKey || Deno.env.get("BRIGHTLOCAL_API_KEY");
    if (!key) throw new Error("BRIGHTLOCAL_API_KEY not set");
    this.apiKey = key;
  }

  private async raw(payload: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    return fetch(MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  async connect(): Promise<void> {
    const initRes = await this.raw({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rom-hq", version: "1.0" },
      },
    });

    const sid = initRes.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // Drain init response
    await initRes.text();

    // Send initialized notification
    await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T | { error: string }> {
    if (!this.sessionId) await this.connect();

    const res = await this.raw({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name, arguments: args },
    });

    const body = await res.text();
    const parsed = parseSSE(body) as MCPResponse<ToolCallResult>;

    if (parsed?.error) {
      return { error: parsed.error.message };
    }

    const content = parsed?.result?.content?.[0]?.text;
    if (!content) return { error: "empty content from MCP" };

    if (content.includes("[INVALID_API_KEY]")) {
      return { error: "INVALID_API_KEY · BrightLocal account needs API access enabled (email contact@brightlocal.com)" };
    }

    // Try parse as JSON, else return raw
    try {
      return JSON.parse(content) as T;
    } catch {
      return content as unknown as T;
    }
  }

  // Typed convenience wrappers
  async findClients(args: { name?: string; per_page?: number; page?: number } = {}) {
    return this.callTool<{ clients?: Array<{ client_id: number; name: string }>; pagination?: unknown }>("find_clients", { per_page: 50, ...args });
  }

  async findLocations(args: { location?: string; client_id?: number; per_page?: number } = {}) {
    return this.callTool<{ locations?: Array<{ location_id: number; name: string; address1?: string; city?: string; region?: string; country?: string; phone?: string; url?: string }> }>("find_locations", { per_page: 50, ...args });
  }

  async getLocation(locationId: number) {
    return this.callTool<Record<string, unknown>>("get_location", { location_id: locationId });
  }

  async getCitationCredits() {
    return this.callTool<{ credits?: number }>("get_citation_credits");
  }

  async getAllCtReports(args: { location_id?: number; per_page?: number } = {}) {
    return this.callTool<{ reports?: Array<{ report_id: number; location_id: number; status: string }> }>("get_all_ct_reports", { per_page: 50, ...args });
  }

  async getCtReport(reportId: number) {
    return this.callTool<{ report_id: number; status: string; location_id: number; total_listings?: number; exact_match?: number; partial_match?: number; missing?: number }>("get_ct_report", { report_id: reportId });
  }

  async getCtReportResults(reportId: number, args: { per_page?: number } = {}) {
    return this.callTool<{ results?: Array<{ source: string; status: string; url?: string; name_match?: boolean; phone_match?: boolean; address_match?: boolean }> }>("get_ct_report_results", { report_id: reportId, per_page: 100, ...args });
  }

  async activeSyncChangeAlerts(args: { location_id?: number; since?: string } = {}) {
    return this.callTool<{ alerts?: Array<{ source: string; field: string; old_value: string; new_value: string; detected_at: string }> }>("active_sync_change_alerts_tool", args);
  }

  async getBrainRecommendations(locationId: number) {
    return this.callTool<{ recommendations?: Array<{ category: string; priority: string; title: string; description: string; impact?: string }>; insights?: unknown }>("get_brain_recommendations", { location_id: locationId });
  }

  async findRmReports(args: { location_id?: number; per_page?: number } = {}) {
    return this.callTool<{ reports?: Array<{ report_id: number; location_id: number; name: string }> }>("find_rm_reports", { per_page: 50, ...args });
  }

  async findRmReviews(args: { report_id: number; per_page?: number; rating_min?: number; rating_max?: number }) {
    return this.callTool<{ reviews?: Array<{ rating: number; text: string; author: string; source: string; created_at: string }> }>("find_rm_reviews", { per_page: 50, ...args });
  }

  async getLrtReportResult(reportId: number) {
    return this.callTool<{ keywords?: Array<{ keyword: string; position: number; url?: string }> }>("get_lrt_report_result", { report_id: reportId });
  }
}
