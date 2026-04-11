import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Bot, User, Loader2, RotateCcw, Mic, MicOff, Volume2, VolumeX, Phone } from "lucide-react";
import ReactMarkdown from "react-markdown";
import Navbar from "@/components/Navbar";
import ResumeUpload from "@/components/ResumeUpload";
//import VoiceInterview from "@/components/VoiceInterview";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { streamInterview, type ChatMessage, type ResumeAnalysis } from "@/lib/ai";
import { extractScoresFromMessage } from "@/lib/scores";
import { useSpeechRecognition, useSpeechSynthesis } from "@/hooks/use-speech";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";

const roles = [
  "Frontend Developer",
  "Backend Developer",
  "Full Stack Engineer",
  "Data Scientist",
  "Product Manager",
  "DevOps Engineer",
  "Machine Learning Engineer",
  "Mobile Developer",
];

const Interview = () => {
  const [selectedRole, setSelectedRole] = useState("");
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [resumeAnalysis, setResumeAnalysis] = useState<ResumeAnalysis | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceCallMode, setVoiceCallMode] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();

  const { isListening, transcript, supported: sttSupported, startListening, stopListening, resetTranscript } = useSpeechRecognition();
  const { isSpeaking, supported: ttsSupported, speak, stop: stopSpeaking } = useSpeechSynthesis();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Sync speech transcript to input
  useEffect(() => {
    if (transcript) setInput(transcript);
  }, [transcript]);

  const createSession = async () => {
    if (!user) return null;
    const { data, error } = await (supabase as any)
      .from("interview_sessions")
      .insert({
        user_id: user.id,
        role: selectedRole,
        resume_analysis: resumeAnalysis,
        messages: [],
        status: "in_progress",
      })
      .select("id")
      .single();
    if (error) console.error("Session create error:", error);
    return data?.id || null;
  };

  const updateSession = async (id: string, msgs: ChatMessage[], status?: string, scores?: any) => {
    await (supabase as any)
      .from("interview_sessions")
      .update({
        messages: msgs,
        ...(status ? { status } : {}),
        ...(scores ? { scores } : {}),
      })
      .eq("id", id);
  };

  const startInterview = async () => {
    if (!selectedRole) return;
    setStarted(true);
    setIsStreaming(true);

    const sid = await createSession();
    setSessionId(sid);

    const resumeContext = resumeAnalysis
      ? `Skills: ${resumeAnalysis.skills.join(", ")}. Experience: ${resumeAnalysis.experience_years} years. Strengths: ${resumeAnalysis.strengths.join(", ")}. Education: ${resumeAnalysis.education}.`
      : undefined;

    let assistantText = "";
    const updateAssistant = (chunk: string) => {
      assistantText += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantText } : m));
        }
        return [...prev, { role: "assistant", content: assistantText }];
      });
    };

    try {
      await streamInterview({
        messages: [],
        role: selectedRole,
        resumeContext,
        onDelta: updateAssistant,
        onDone: () => {
          setIsStreaming(false);
          if (voiceMode && autoSpeak && assistantText) speak(assistantText);
          if (sid) {
            const finalMsgs = [{ role: "assistant" as const, content: assistantText }];
            updateSession(sid, finalMsgs);
          }
        },
      });
    } catch (e) {
      console.error(e);
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to start interview", variant: "destructive" });
      setIsStreaming(false);
    }
  };

  const sendAnswer = async () => {
    if (!input.trim() || isStreaming) return;
    if (isListening) stopListening();
    
    const userMsg: ChatMessage = { role: "user", content: input };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    resetTranscript();
    setIsStreaming(true);

    let assistantText = "";
    const updateAssistant = (chunk: string) => {
      assistantText += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantText } : m));
        }
        return [...prev, { role: "assistant", content: assistantText }];
      });
    };

    const resumeContext = resumeAnalysis
      ? `Skills: ${resumeAnalysis.skills.join(", ")}. Experience: ${resumeAnalysis.experience_years} years.`
      : undefined;

    try {
      await streamInterview({
        messages: updatedMessages,
        role: selectedRole,
        resumeContext,
        onDelta: updateAssistant,
        onDone: () => {
          setIsStreaming(false);
          if (voiceMode && autoSpeak && assistantText) speak(assistantText);
          if (sessionId) {
            const finalMsgs = [...updatedMessages, { role: "assistant" as const, content: assistantText }];
            // Try to extract scores from the AI's response
            const scores = extractScoresFromMessage(assistantText);
            updateSession(sessionId, finalMsgs, scores ? "completed" : undefined, scores || undefined);
          }
        },
      });
    } catch (e) {
      console.error(e);
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to get response", variant: "destructive" });
      setIsStreaming(false);
    }
  };

  const endInterview = async () => {
    stopSpeaking();
    if (sessionId) {
      // Check last assistant message for scores
      const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
      const scores = lastAssistant ? extractScoresFromMessage(lastAssistant.content) : null;
      await updateSession(sessionId, messages, "completed", scores || undefined);
    }
    navigate("/results" + (sessionId ? `?session=${sessionId}` : ""));
  };

  const reset = () => {
    stopSpeaking();
    setStarted(false);
    setMessages([]);
    setInput("");
    setSelectedRole("");
    setResumeAnalysis(null);
    setSessionId(null);
  };

  const toggleVoice = () => {
    if (isListening) stopListening();
    else startListening();
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />
      <main className="flex flex-1 flex-col container mx-auto px-6 pt-24 pb-8">
        {!started ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto w-full max-w-2xl mt-8"
          >
            <div className="text-center mb-8">
              <div className="gradient-primary rounded-2xl p-4 inline-block mb-4">
                <Bot className="h-10 w-10 text-primary-foreground" />
              </div>
              <h1 className="text-3xl font-bold text-foreground">AI Mock Interview</h1>
              <p className="mt-2 text-muted-foreground">
                Upload your resume for personalized questions, then start a live AI interview.
              </p>
            </div>

            <div className="space-y-6">
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">
                  1. Upload Your Resume
                </label>
                <ResumeUpload onAnalysisComplete={setResumeAnalysis} analysis={resumeAnalysis} />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">
                  2. Select Target Role
                </label>
                <Select onValueChange={setSelectedRole} value={selectedRole}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                    {resumeAnalysis?.recommended_roles?.map((r) => (
                      !roles.includes(r) && (
                        <SelectItem key={r} value={r}>
                          {r} <span className="text-muted-foreground">(recommended)</span>
                        </SelectItem>
                      )
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Voice Mode Toggle */}
              {(sttSupported || ttsSupported) && (
                <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2">
                      <Mic className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Browser Voice Mode</p>
                      <p className="text-xs text-muted-foreground">Speak answers & hear AI (browser speech)</p>
                    </div>
                  </div>
                  <Switch checked={voiceMode} onCheckedChange={(v) => { setVoiceMode(v); if (v) setVoiceCallMode(false); }} />
                </div>
              )}

              {/* ElevenLabs Voice Call Mode
              <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Phone className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Real-Time Voice Call</p>
                    <p className="text-xs text-muted-foreground">Natural phone-call style with ElevenLabs AI</p>
                  </div>
                </div>
                <Switch checked={voiceCallMode} onCheckedChange={(v) => { setVoiceCallMode(v); if (v) setVoiceMode(false); }} />
              </div> */}

              <Button
                onClick={voiceCallMode ? () => setStarted(true) : startInterview}
                disabled={!selectedRole}
                className="w-full gradient-primary text-primary-foreground border-0 hover:opacity-90"
                size="lg"
              >
                {voiceCallMode ? "Start Voice Call Interview" : voiceMode ? "Start Voice Interview" : "Start Live Interview"}
              </Button>
            </div>
          </motion.div>
        ) : voiceCallMode ? (
          <VoiceInterview
            role={selectedRole}
            resumeContext={resumeAnalysis ? `Skills: ${resumeAnalysis.skills.join(", ")}. Experience: ${resumeAnalysis.experience_years} years.` : undefined}
            onEnd={() => navigate("/results")}
          />
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-foreground">Live Interview</h1>
                <Badge variant="secondary">{selectedRole}</Badge>
                {resumeAnalysis && <Badge variant="outline" className="text-xs">Resume Loaded</Badge>}
                {voiceMode && <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">🎙 Voice</Badge>}
              </div>
              <div className="flex gap-2">
                {ttsSupported && (
                  <Button variant="ghost" size="sm" onClick={() => setAutoSpeak(!autoSpeak)} title={autoSpeak ? "Mute AI voice" : "Enable AI voice"}>
                    {autoSpeak ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={endInterview}>
                  End Interview
                </Button>
                <Button variant="ghost" size="sm" onClick={reset}>
                  <RotateCcw className="h-4 w-4 mr-1" /> New
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 mb-4 rounded-xl border border-border bg-card p-4">
              <AnimatePresence mode="popLayout">
                {messages.map((msg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
                  >
                    {msg.role === "assistant" && (
                      <div className="shrink-0 rounded-full gradient-primary p-2 h-8 w-8 flex items-center justify-center mt-1">
                        <Bot className="h-4 w-4 text-primary-foreground" />
                      </div>
                    )}
                    <div className={`max-w-[75%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}>
                      {msg.role === "assistant" ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:mb-2 [&>ul]:mb-2 [&>ol]:mb-2">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <p>{msg.content}</p>
                      )}
                      {/* Speak button for individual messages */}
                      {msg.role === "assistant" && ttsSupported && !isStreaming && (
                        <button
                          onClick={() => isSpeaking ? stopSpeaking() : speak(msg.content)}
                          className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {isSpeaking ? "⏹ Stop" : "🔊 Listen"}
                        </button>
                      )}
                    </div>
                    {msg.role === "user" && (
                      <div className="shrink-0 rounded-full bg-secondary p-2 h-8 w-8 flex items-center justify-center mt-1">
                        <User className="h-4 w-4 text-secondary-foreground" />
                      </div>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
              {isStreaming && messages.length === 0 && (
                <div className="flex gap-3">
                  <div className="shrink-0 rounded-full gradient-primary p-2 h-8 w-8 flex items-center justify-center">
                    <Bot className="h-4 w-4 text-primary-foreground" />
                  </div>
                  <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing your interview...
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="flex gap-3">
              {voiceMode && sttSupported && (
                <Button
                  onClick={toggleVoice}
                  variant={isListening ? "destructive" : "outline"}
                  size="icon"
                  className={`shrink-0 ${isListening ? "animate-pulse" : ""}`}
                  disabled={isStreaming}
                  title={isListening ? "Stop recording" : "Start recording"}
                >
                  {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
              )}
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={voiceMode && isListening ? "Listening..." : "Type your answer..."}
                className="min-h-[60px] resize-none"
                disabled={isStreaming}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendAnswer();
                  }
                }}
              />
              <Button
                onClick={sendAnswer}
                disabled={!input.trim() || isStreaming}
                className="gradient-primary text-primary-foreground border-0 hover:opacity-90 shrink-0"
                size="icon"
              >
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default Interview;
