import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectSupabaseEnv,
  isLocalSupabaseUrl,
  parseEnvFile,
  supabaseHost
} from "./env-detect.js";

const CWD = "/repo";

function reader(files: Record<string, string>): (path: string) => string | undefined {
  return (path: string) => {
    for (const [name, content] of Object.entries(files)) {
      if (path === join(CWD, name)) return content;
    }
    return undefined;
  };
}

describe("parseEnvFile", () => {
  it("parses KEY=VALUE with export prefixes, quotes, and comments", () => {
    const values = parseEnvFile(
      [
        "# a comment",
        "",
        "SUPABASE_URL=https://abc.supabase.co",
        'export SUPABASE_SERVICE_ROLE_KEY="sk-secret-value"',
        "SINGLE='quoted'",
        "NOT A LINE",
        "=nokey"
      ].join("\n")
    );
    expect(values.SUPABASE_URL).toBe("https://abc.supabase.co");
    expect(values.SUPABASE_SERVICE_ROLE_KEY).toBe("sk-secret-value");
    expect(values.SINGLE).toBe("quoted");
    expect(Object.keys(values)).toHaveLength(3);
  });
});

describe("detectSupabaseEnv", () => {
  it("finds SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local", () => {
    const result = detectSupabaseEnv(
      CWD,
      reader({
        ".env.local":
          "SUPABASE_URL=https://abc.supabase.co/\nSUPABASE_SERVICE_ROLE_KEY=sk-1\n"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.url).toBe("https://abc.supabase.co");
    expect(result.env.serviceKey).toBe("sk-1");
    expect(result.env.urlVariable).toBe("SUPABASE_URL");
    expect(result.env.sourceFile).toBe(".env.local");
  });

  it("accepts the alias spellings NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY from .env", () => {
    const result = detectSupabaseEnv(
      CWD,
      reader({
        ".env": "NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co\nSUPABASE_SERVICE_KEY=sk-2\n"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.urlVariable).toBe("NEXT_PUBLIC_SUPABASE_URL");
    expect(result.env.serviceKeyVariable).toBe("SUPABASE_SERVICE_KEY");
    expect(result.env.sourceFile).toBe(".env");
  });

  it(".env.local wins per variable; the two variables may come from different files", () => {
    const result = detectSupabaseEnv(
      CWD,
      reader({
        ".env.local": "SUPABASE_URL=https://local.supabase.co\n",
        ".env": "SUPABASE_URL=https://stale.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sk-env\n"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.url).toBe("https://local.supabase.co");
    expect(result.env.serviceKey).toBe("sk-env");
  });

  it("reports which files were checked when nothing is found", () => {
    const result = detectSupabaseEnv(CWD, reader({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.checkedFiles).toEqual([".env.local", ".env"]);
  });

  it("treats a URL without a key (and vice versa) as a miss", () => {
    const urlOnly = detectSupabaseEnv(
      CWD,
      reader({ ".env.local": "SUPABASE_URL=https://abc.supabase.co\n" })
    );
    expect(urlOnly.ok).toBe(false);
    const keyOnly = detectSupabaseEnv(
      CWD,
      reader({ ".env": "SUPABASE_SERVICE_ROLE_KEY=sk-1\n" })
    );
    expect(keyOnly.ok).toBe(false);
  });
});

describe("supabaseHost + isLocalSupabaseUrl", () => {
  it("extracts the bare host", () => {
    expect(supabaseHost("https://abc.supabase.co")).toBe("abc.supabase.co");
    expect(supabaseHost("http://127.0.0.1:54321")).toBe("127.0.0.1:54321");
  });

  it("flags localhost / 127.0.0.1 / 0.0.0.0 as local", () => {
    expect(isLocalSupabaseUrl("http://localhost:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://0.0.0.0:8000")).toBe(true);
    expect(isLocalSupabaseUrl("https://abc.supabase.co")).toBe(false);
  });
});
