import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import crypto from "crypto";

const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;

function verifyHmacSignature(payload: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  // ElevenLabs signature format: "t=<timestamp>,v0=<hash>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, ...v] = p.split("=");
      return [k, v.join("=")];
    })
  );
  const timestamp = parts["t"];
  const expectedSig = parts["v0"];
  if (!timestamp || !expectedSig) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const computed = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSig));
}

export async function GET() {
  return NextResponse.json({
    message: "ElevenLabs Post-Call Webhook Endpoint",
    method: "POST",
    status: "ready",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    console.log("🔔 Post-call webhook HIT:", {
      hasSignature: !!req.headers.get("elevenlabs-signature"),
      hasSecret: !!WEBHOOK_SECRET,
      bodyLength: rawBody.length,
    });

    // HMAC signature validation (if secret is configured)
    if (WEBHOOK_SECRET) {
      const signature = req.headers.get("elevenlabs-signature");
      if (!verifyHmacSignature(rawBody, signature, WEBHOOK_SECRET)) {
        console.error("❌ HMAC validation failed — check ELEVENLABS_WEBHOOK_SECRET matches ElevenLabs config");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);

    // ElevenLabs wraps payload under { type, data, event_timestamp }
    const eventType = body.type;
    const data = body.data ?? body;

    // Only process transcription webhooks
    if (eventType && eventType !== "post_call_transcription") {
      console.log(`⏭️ Ignoring webhook type: ${eventType}`);
      return NextResponse.json({ success: true, message: `Ignored event type: ${eventType}` });
    }

    const conversation_id = data.conversation_id;
    const agent_id = data.agent_id;
    const transcript = data.transcript;
    const call_duration_secs = data.metadata?.call_duration_secs;

    console.log("📝 Post-call webhook received:", {
      type: eventType,
      conversation_id,
      agent_id,
      duration: call_duration_secs,
    });

    if (!conversation_id) {
      return NextResponse.json({ error: "Missing conversation_id" }, { status: 400 });
    }

    const supabase = await createServiceClient();

    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("*")
      .eq("elevenlabs_conversation_id", conversation_id)
      .single();

    if (convError || !conversation) {
      console.log("⚠️ Conversation not found, creating minimal record");
      return NextResponse.json({ 
        success: true, 
        message: "Webhook received but conversation not tracked" 
      });
    }

    // ElevenLabs transcript uses 'message' field, not 'content'
    const transcriptText = Array.isArray(transcript)
      ? transcript.map((m: { role: string; message?: string; content?: string }) => `${m.role}: ${m.message ?? m.content ?? ""}`).join("\n")
      : JSON.stringify(transcript);

    // Use ElevenLabs built-in transcript summary (no external LLM needed)
    const summary = data.analysis?.transcript_summary ?? "";

    // Store the summary as a memory so the companion remembers the conversation
    const memories: { content: string; category: string; importance: number }[] = [];
    if (summary) {
      memories.push({ content: summary, category: "other", importance: 5 });
    }

    // Also extract user messages as lightweight memories
    if (Array.isArray(transcript)) {
      const userMessages = transcript
        .filter((m: { role: string }) => m.role === "user")
        .map((m: { message?: string; content?: string }) => m.message ?? m.content ?? "")
        .filter((msg: string) => msg.length > 20);
      for (const msg of userMessages.slice(0, 3)) {
        memories.push({ content: `User said: ${msg}`, category: "other", importance: 3 });
      }
    }

    await supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        duration_seconds: call_duration_secs ?? null,
        transcript,
        summary,
      })
      .eq("id", conversation.id);

    if (memories.length > 0) {
      const memoryRows = memories.map((m) => ({
        user_id: conversation.user_id,
        agent_id: conversation.agent_id,
        conversation_id: conversation.id,
        content: m.content,
        category: m.category,
        importance: m.importance ?? 5,
      }));
      console.log("💾 Inserting memories into Supabase:", JSON.stringify(memoryRows, null, 2));
      const { error: memError } = await supabase.from("memories").insert(memoryRows);
      if (memError) console.error("❌ Memory insert error:", memError);
    }

    console.log("✅ Post-call processing complete:", {
      conversationId: conversation.id,
      memoriesSaved: memories.length,
      hasSummary: !!summary,
      summaryPreview: summary.slice(0, 100),
    });

    return NextResponse.json({ success: true, memoriesSaved: memories.length });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}