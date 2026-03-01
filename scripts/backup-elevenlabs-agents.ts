import * as fs from "fs";
import * as path from "path";

// Parse .env.local manually to avoid dotenv dependency
const envPath = path.resolve(__dirname, "../.env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error("❌ ELEVENLABS_API_KEY not found in .env.local");
  process.exit(1);
}

const AGENTS: Record<string, string> = {
  "Maya Thompson": "agent_0401kjm7e8p0fv69y263sgvcmc1n",
  "Daniel Mercer": "agent_6901kjm7eag1e2ctx53hnfn352x4",
  "Claire Donovan": "agent_0001kjm7ebvef2bvgy5y0q7tzewk",
  "Tom Gallagher": "agent_3801kjm7ed6mf42vttvh9n0tknd6",
  "Harold Bennett": "agent_4101kjm7eejzf7vbxyn4ym19q9nt",
  "Mateo Rivera": "agent_7801kjm7eg0xenx9jrqr5fcn9ft3",
  "Dr. Ana Morales": "agent_3601kjm7ehdkfzfs1f387t4xqexq",
  "Rosa Gutierrez": "agent_6601kjm7ejxmf558s936j1stz7ha",
  "Priya Sharma": "agent_1901kjm7em7cfxttek93v193yf9p",
  "Kavita Devi": "agent_9001kjm7enkzfsyb06pav5d3bcj1",
  "Jimmy Carter": "agent_4601kjm7eq47f3wa35n29t4fnk28",
};

async function fetchAgent(name: string, agentId: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    headers: { "xi-api-key": API_KEY! },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ Failed to fetch ${name} (${agentId}): ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  console.log(`✅ Fetched ${name} (${agentId})`);
  return data;
}

async function main() {
  console.log(`📦 Backing up ${Object.keys(AGENTS).length} ElevenLabs agents...\n`);

  const backup: Record<string, unknown> = {
    _meta: {
      exported_at: new Date().toISOString(),
      agent_count: Object.keys(AGENTS).length,
    },
    agents: {} as Record<string, unknown>,
  };

  for (const [name, agentId] of Object.entries(AGENTS)) {
    const config = await fetchAgent(name, agentId);
    if (config) {
      (backup.agents as Record<string, unknown>)[name] = {
        agent_id: agentId,
        config,
      };
    }
  }

  const outPath = path.resolve(__dirname, "../elevenlabs-agents-backup.json");
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));
  console.log(`\n💾 Backup saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
