import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    const body = await req.json();

    // ElevenLabs wraps everything in body.data for post_call_transcription events
    const payload = body.data ?? body;

    const conversation_id = payload.conversation_id;
    const agent_id = payload.agent_id;
    const transcript = payload.transcript;
    const call_duration_seconds =
      payload.call_duration_secs ??
      payload.call_duration_seconds ??
      payload.metadata?.call_duration_secs ??
      null;

    console.log("📝 Post-call webhook received:", {
      type: body.type,
      conversation_id,
      agent_id,
      duration: call_duration_seconds,
    });

    // Ignore non-transcription events (post_call_audio, call_initiation_failure)
    if (body.type && body.type !== "post_call_transcription") {
      console.log("Ignoring event type:", body.type);
      return NextResponse.json({ received: true });
    }

    if (!conversation_id) {
      console.error("Missing conversation_id. Full payload:", JSON.stringify(body, null, 2));
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

    // ElevenLabs transcript uses { role: "agent"|"user", message: "..." }
    const transcriptText = Array.isArray(transcript)
      ? transcript
          .map((m: { role: string; message?: string; content?: string }) =>
            `${m.role === "agent" ? "Assistant" : "User"}: ${m.message ?? m.content ?? ""}`
          )
          .join("\n")
      : JSON.stringify(transcript);

    // Convert to our DB format { role: "assistant"|"user", content: "..." }
    const formattedTranscript = Array.isArray(transcript)
      ? transcript.map((m: { role: string; message?: string; content?: string; time_in_call_secs?: number }) => ({
          role: m.role === "agent" ? "assistant" : "user",
          content: m.message ?? m.content ?? "",
          timestamp: m.time_in_call_secs,
        }))
      : transcript;

    let memories: { content: string; category: string; importance: number }[] = [];
    
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const memoryResponse = await anthropic.messages.create({
          model: "claude-opus-4-5",
          max_tokens: 500,
          system: `Extract 3-5 key facts about the USER (not the AI) from this conversation transcript.
Return ONLY a valid JSON array with no other text: [{"content": "fact about user", "category": "family|work|health|interests|other", "importance": 1-10}]
Only include facts that would be meaningful to remember for future conversations.`,
          messages: [{ role: "user", content: transcriptText }],
        });

        const rawText = memoryResponse.content[0].type === "text" ? memoryResponse.content[0].text : "[]";
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          memories = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        console.error("Memory extraction failed:", err);
      }
    }

    // Use ElevenLabs summary if available, otherwise generate with Claude
    let summary = payload.analysis?.transcript_summary ?? "";
    if (!summary && process.env.ANTHROPIC_API_KEY) {
      try {
        const summaryResponse = await anthropic.messages.create({
          model: "claude-opus-4-5",
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: `Summarize this conversation in 2-3 warm, personal sentences from the perspective of an AI companion recap:\n\n${transcriptText}`,
            },
          ],
        });
        summary =
          summaryResponse.content[0].type === "text"
            ? summaryResponse.content[0].text
            : "";
      } catch (err) {
        console.error("Summary generation failed:", err);
      }
    }

    await supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        duration_seconds: call_duration_seconds ?? null,
        transcript: formattedTranscript,
        summary,
      })
      .eq("id", conversation.id);

    if (memories.length > 0) {
      await supabase.from("memories").insert(
        memories.map((m) => ({
          user_id: conversation.user_id,
          agent_id: conversation.agent_id,
          conversation_id: conversation.id,
          content: m.content,
          category: m.category,
          importance: m.importance ?? 5,
        }))
      );
    }

    console.log("✅ Post-call processing complete:", {
      memoriesSaved: memories.length,
      hasSummary: !!summary,
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
