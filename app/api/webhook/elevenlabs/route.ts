import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

interface ElevenLabsTranscriptTurn {
  role: "agent" | "user";
  message: string;
  time_in_call_secs?: number;
}

interface ElevenLabsWebhookPayload {
  type: "post_call_transcription" | "post_call_audio" | "call_initiation_failure";
  event_timestamp: number;
  data: {
    agent_id: string;
    conversation_id: string;
    status?: string;
    transcript?: ElevenLabsTranscriptTurn[];
    metadata?: {
      call_duration_secs?: number;
      start_time_unix_secs?: number;
    };
    analysis?: {
      transcript_summary?: string;
      call_successful?: string;
    };
    conversation_initiation_client_data?: {
      dynamic_variables?: Record<string, string>;
    };
    failure_reason?: string;
  };
}

export async function POST(req: NextRequest) {
  try {
    const payload: ElevenLabsWebhookPayload = await req.json();

    // Handle call initiation failures — log and return 200
    if (payload.type === "call_initiation_failure") {
      console.log("Call initiation failed:", payload.data.failure_reason, payload.data.conversation_id);
      return NextResponse.json({ received: true });
    }

    // Only process transcription webhooks
    if (payload.type !== "post_call_transcription") {
      return NextResponse.json({ received: true });
    }

    const { data } = payload;
    const { conversation_id, transcript, metadata, analysis } = data;

    if (!conversation_id) {
      return NextResponse.json({ error: "Missing conversation_id" }, { status: 400 });
    }

    const supabase = await createServiceClient();

    // Find the conversation record by ElevenLabs conversation ID
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("*")
      .eq("elevenlabs_conversation_id", conversation_id)
      .single();

    if (convError || !conversation) {
      console.error("Conversation not found for elevenlabs_conversation_id:", conversation_id);
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    // Convert ElevenLabs transcript format to our format
    const formattedTranscript = (transcript ?? []).map((turn) => ({
      role: turn.role === "agent" ? "assistant" : "user",
      content: turn.message,
      timestamp: turn.time_in_call_secs,
    }));

    // Use ElevenLabs built-in transcript summary (no external LLM needed)
    const summary = analysis?.transcript_summary ?? "";

    // Store the summary as a memory so the companion remembers the conversation
    const memories: { content: string; category: string; importance: number }[] = [];
    if (summary) {
      memories.push({ content: summary, category: "other", importance: 5 });
    }

    // Also extract user messages as lightweight memories
    if (transcript) {
      const userMessages = transcript
        .filter((t) => t.role === "user")
        .map((t) => t.message)
        .filter((msg) => msg.length > 20);
      for (const msg of userMessages.slice(0, 3)) {
        memories.push({ content: `User said: ${msg}`, category: "other", importance: 3 });
      }
    }

    // Update conversation record
    await supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        duration_seconds: metadata?.call_duration_secs ?? null,
        transcript: formattedTranscript,
        summary,
      })
      .eq("id", conversation.id);

    // Save extracted memories
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

    console.log(`Webhook processed: conversation ${conversation_id}, memories saved: ${memories.length}`);
    return NextResponse.json({ received: true, memoriesSaved: memories.length });

  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
