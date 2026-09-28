import { useEffect, useState } from "react";

export function AskGrantDeskChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([
    {
      sender: "ai",
      text: "Hello! I am your GrantDesk Intelligence Assistant. Press Cmd+K anywhere or ask me about Canadian/US funding programs, client eligibility, or draft criteria.",
    },
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSend = (textToSend?: string) => {
    const q = textToSend || query;
    if (!q.trim()) return;
    setMessages((prev) => [...prev, { sender: "user", text: q.trim() }]);
    setQuery("");

    setTimeout(() => {
      let reply = "I analyzed our catalog and past awards. ";
      const lower = q.toLowerCase();
      if (lower.includes("ontario") || lower.includes("clean")) {
        reply +=
          "Found 3 matching opportunities in Ontario for clean technology: 1. Sustainable Development Technology Canada (SDTC) Seed Fund, 2. Ontario Centre of Innovation (OCI) Voucher Program, 3. ECCC Clean Growth Grant.";
      } else if (lower.includes("quick") || lower.includes("win")) {
        reply +=
          "Identified 2 Quick-Win grants with estimated ROI > $5,000/hr and < 15 writing hours required.";
      } else {
        reply +=
          "Based on client profiles, 4 open calls match your eligibility requirements with 85%+ confidence.";
      }
      setMessages((prev) => [...prev, { sender: "ai", text: reply }]);
    }, 500);
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="fixed bottom-5 right-5 p-3 rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 transition-transform active:scale-95 text-xs font-bold flex items-center gap-2 cursor-pointer z-50"
      >
        <span>
          💬 Ask GrantDesk <kbd className="text-[10px] opacity-75 font-mono">⌘K</kbd>
        </span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 w-80 sm:w-96 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl z-50 flex flex-col max-h-[500px]">
      <div className="flex items-center justify-between p-3 border-b border-slate-100 dark:border-slate-800 bg-indigo-600 text-white rounded-t-xl">
        <h4 className="text-xs font-bold flex items-center gap-1.5">
          <span>⚡ GrantDesk AI Insights</span>
        </h4>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="text-xs hover:opacity-80 px-1 cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div className="p-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => handleSend("Ontario clean tech grants")}
          className="text-[10px] px-2 py-0.5 rounded bg-white dark:bg-slate-700 border text-slate-600 dark:text-slate-300 hover:bg-indigo-50 cursor-pointer"
        >
          🌱 Ontario Clean Tech
        </button>
        <button
          type="button"
          onClick={() => handleSend("Show Quick Wins")}
          className="text-[10px] px-2 py-0.5 rounded bg-white dark:bg-slate-700 border text-slate-600 dark:text-slate-300 hover:bg-emerald-50 cursor-pointer"
        >
          ⚡ Quick Wins
        </button>
      </div>

      <div className="flex-1 p-3 overflow-y-auto space-y-2 text-xs min-h-[250px]">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={`p-2.5 rounded-lg max-w-[85%] ${
              m.sender === "user"
                ? "ml-auto bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200"
            }`}
          >
            {m.text}
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-slate-100 dark:border-slate-800 flex gap-2">
        <input
          type="text"
          placeholder="Ask about grants, eligibility..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          className="flex-1 p-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        />
        <button
          type="button"
          onClick={() => handleSend()}
          className="px-3 py-1.5 text-xs font-bold rounded bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  );
}
