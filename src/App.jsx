import { useState, useRef, useEffect } from "react";

const SYSTEM_PROMPT = `Eres un asistente de agendamiento médico. SIEMPRE respondes ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin explicaciones, sin markdown.

REGLAS ESTRICTAS:
- Tu respuesta SIEMPRE debe comenzar con { y terminar con }
- NUNCA escribas texto fuera del JSON
- NUNCA uses bloques de código o markdown

FORMATOS DE RESPUESTA:

1. Cuando el usuario proporcione datos de paciente (nombre, fecha, hora, teléfono):
{"action":"confirm","data":{"nombre":"nombre completo","fecha":"DD/MM/YYYY","hora":"HH:MM","telefono":"número"},"resumen":"Mensaje confirmando los datos"}

2. Cuando falten datos:
{"action":"missing","faltante":["campo1","campo2"],"resumen":"Mensaje pidiendo los datos faltantes"}

3. Cuando el usuario confirme (sí, confirmar, correcto, ok, etc.):
{"action":"save","resumen":"Mensaje de éxito"}

4. Cuando el usuario cancele:
{"action":"cancel","resumen":"Mensaje de cancelación"}

5. Para saludos o preguntas generales:
{"action":"chat","resumen":"Tu respuesta"}

Hoy es ${new Date().toLocaleDateString("es-MX", {weekday:"long", year:"numeric", month:"long", day:"numeric"})}.
Interpreta fechas relativas como "mañana", "el lunes", "próximo martes", "viernes" correctamente.
Responde siempre en español.`;

const defaultClinics = [{ id: 1, name: "Clínica Principal", url: "" }];

const styles = {
  font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

export default function App() {
  const [clinics, setClinics] = useState(defaultClinics);
  const [selectedClinic, setSelectedClinic] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [pendingData, setPendingData] = useState(null);
  const [view, setView] = useState("setup");
  const [configOpen, setConfigOpen] = useState(false);
  const [newClinicName, setNewClinicName] = useState("");
  const [newClinicUrl, setNewClinicUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const messagesEnd = useRef(null);
  const recognitionRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const addMessage = (role, text, type = "text") =>
    setMessages(prev => [...prev, { role, text, type, id: Date.now() + Math.random() }]);

  const toggleListening = () => {
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Usa Chrome para reconocimiento de voz."); return; }
    const r = recognitionRef.current = new SR();
    r.lang = "es-MX"; r.continuous = true; r.interimResults = true;
    r.onstart = () => setListening(true);
    r.onresult = e => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setInput(prev => (prev + final) || interim);
    };
    r.onspeechend = () => { r.stop(); setListening(false); };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
  };

  const sendToSheets = async (data, clinic) => {
    if (!clinic.url) return false;
    try {
      await fetch(clinic.url, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, clinica: clinic.name, timestamp: new Date().toISOString() }),
      });
      return true;
    } catch { return false; }
  };

  const sendMessage = async (text) => {
    if (!text.trim() || loading) return;
    setInput("");
    addMessage("user", text);
    setLoading(true);

    const history = messages.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.role === "user" ? m.text : m.rawText || m.text
    }));
    history.push({ role: "user", content: text });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, system: SYSTEM_PROMPT, messages: history }),
      });
      const data = await res.json();
      const rawText = data.content?.[0]?.text || "{}";
      let parsed;
      try { parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim()); }
      catch { parsed = { action: "chat", resumen: rawText }; }

      if (parsed.action === "confirm" && parsed.data) {
        setPendingData(parsed.data);
        setMessages(prev => [...prev, { role: "assistant", text: parsed.resumen, type: "confirm", data: parsed.data, rawText, id: Date.now() }]);
      } else if (parsed.action === "save" && pendingData) {
        setSaving(true);
        await sendToSheets(pendingData, selectedClinic);
        setSaving(false);
        addMessage("assistant", `Cita confirmada para ${pendingData.nombre} el ${pendingData.fecha} a las ${pendingData.hora}.`);
        setPendingData(null);
      } else if (parsed.action === "cancel") {
        setPendingData(null);
        addMessage("assistant", parsed.resumen || "Agendamiento cancelado.");
      } else {
        addMessage("assistant", parsed.resumen || "Entendido.");
      }
    } catch { addMessage("assistant", "Ocurrió un error. Intenta de nuevo."); }
    setLoading(false);
  };

  const confirmSave = () => sendMessage("sí, confirmar");
  const cancelSave = () => sendMessage("cancelar");

  const startChat = (clinic) => {
    setSelectedClinic(clinic);
    setView("chat");
    setMessages([{
      role: "assistant", text: `Hola. Soy tu asistente de agendamiento para ${clinic.name}.\n\nDicta o escribe los datos del paciente y me encargo del resto.`,
      type: "text", id: Date.now()
    }]);
  };

  const addClinic = () => {
    if (!newClinicName.trim()) return;
    setClinics(prev => [...prev, { id: Date.now(), name: newClinicName, url: newClinicUrl }]);
    setNewClinicName(""); setNewClinicUrl("");
  };

  const updateClinicUrl = (id, url) => setClinics(prev => prev.map(c => c.id === id ? { ...c, url } : c));

  // SETUP VIEW
  if (view === "setup") return (
    <div style={{ minHeight: "100vh", background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: styles.font, padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{ width: 48, height: 48, background: "#000", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 22 }}>🏥</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "#0a0a0a", letterSpacing: "-0.5px" }}>Agendamiento</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#888", fontWeight: 400 }}>Selecciona una clínica para comenzar</p>
        </div>

        {/* Clinic list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          {clinics.map(c => (
            <button key={c.id} onClick={() => startChat(c)} style={{
              padding: "14px 18px", borderRadius: 12, border: "1px solid #e5e5e5",
              background: "white", cursor: "pointer", textAlign: "left",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              transition: "all .15s", boxShadow: "0 1px 3px rgba(0,0,0,.04)"
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#000"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,.08)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e5e5"; e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,.04)"; }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#0a0a0a" }}>{c.name}</div>
                <div style={{ fontSize: 12, color: c.url ? "#16a34a" : "#d97706", marginTop: 2 }}>
                  {c.url ? "Conectada a Sheets" : "Sin configurar"}
                </div>
              </div>
              <span style={{ color: "#ccc", fontSize: 16 }}>›</span>
            </button>
          ))}
        </div>

        {/* Config toggle */}
        <button onClick={() => setConfigOpen(!configOpen)} style={{
          width: "100%", padding: "11px", borderRadius: 10, border: "1px dashed #d5d5d5",
          background: "transparent", cursor: "pointer", color: "#888", fontSize: 13, fontFamily: styles.font
        }}>
          {configOpen ? "Cerrar configuración" : "⚙ Configurar clínicas"}
        </button>

        {configOpen && (
          <div style={{ marginTop: 12, padding: 18, background: "white", borderRadius: 12, border: "1px solid #e5e5e5" }}>
            <p style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 500, color: "#0a0a0a" }}>URLs de Google Apps Script</p>
            {clinics.map(c => (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 12, color: "#666", marginBottom: 5 }}>{c.name}</label>
                <input value={c.url} onChange={e => updateClinicUrl(c.id, e.target.value)}
                  placeholder="https://script.google.com/macros/s/..."
                  style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 12, fontFamily: styles.font, outline: "none", boxSizing: "border-box", color: "#0a0a0a" }} />
              </div>
            ))}
            <div style={{ height: 1, background: "#f0f0f0", margin: "16px 0" }} />
            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: "#0a0a0a" }}>Nueva clínica</p>
            <input value={newClinicName} onChange={e => setNewClinicName(e.target.value)} placeholder="Nombre"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 13, fontFamily: styles.font, marginBottom: 8, outline: "none", boxSizing: "border-box" }} />
            <input value={newClinicUrl} onChange={e => setNewClinicUrl(e.target.value)} placeholder="URL del script (opcional)"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 12, fontFamily: styles.font, marginBottom: 10, outline: "none", boxSizing: "border-box" }} />
            <button onClick={addClinic} style={{
              padding: "9px 18px", borderRadius: 8, background: "#0a0a0a", color: "white",
              border: "none", cursor: "pointer", fontSize: 13, fontFamily: styles.font, fontWeight: 500
            }}>Agregar</button>
          </div>
        )}
      </div>
    </div>
  );

  // CHAT VIEW
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fafafa", fontFamily: styles.font }}>

      {/* Header */}
      <div style={{ background: "white", borderBottom: "1px solid #f0f0f0", padding: "14px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => setView("setup")} style={{
          width: 32, height: 32, borderRadius: 8, border: "1px solid #e5e5e5",
          background: "white", cursor: "pointer", fontSize: 14, color: "#666",
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#0a0a0a" }}>{selectedClinic?.name}</div>
          <div style={{ fontSize: 12, color: "#aaa", marginTop: 1 }}>Asistente de agendamiento</div>
        </div>
        <div style={{ fontSize: 12, color: "#bbb" }}>
          {new Date().toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" })}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
        {messages.map(m => (
          <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", gap: 10 }}>

            {m.role === "assistant" && (
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "#0a0a0a", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, marginTop: 2 }}>🏥</div>
            )}

            <div style={{ maxWidth: "72%" }}>
              <div style={{
                padding: "12px 16px",
                borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "4px 18px 18px 18px",
                background: m.role === "user" ? "#0a0a0a" : "white",
                color: m.role === "user" ? "white" : "#0a0a0a",
                fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap",
                border: m.role === "assistant" ? "1px solid #f0f0f0" : "none",
                boxShadow: "0 1px 4px rgba(0,0,0,.05)"
              }}>
                {m.text}
              </div>

              {/* Confirm card */}
              {m.type === "confirm" && m.data && pendingData && (
                <div style={{ marginTop: 10, background: "white", border: "1px solid #e5e5e5", borderRadius: 14, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.05)" }}>
                  <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" }}>Confirmar cita</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                    {[
                      { label: "Paciente", value: m.data.nombre },
                      { label: "Fecha", value: m.data.fecha },
                      { label: "Hora", value: m.data.hora },
                      { label: "Teléfono", value: m.data.telefono },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "#999" }}>{label}</span>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "#0a0a0a" }}>{value}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={confirmSave} disabled={saving} style={{
                      flex: 1, padding: "10px", borderRadius: 10, background: "#0a0a0a",
                      color: "white", border: "none", cursor: "pointer", fontSize: 13,
                      fontWeight: 500, fontFamily: styles.font
                    }}>
                      {saving ? "Guardando..." : "Confirmar"}
                    </button>
                    <button onClick={cancelSave} style={{
                      flex: 1, padding: "10px", borderRadius: 10, background: "#f5f5f5",
                      color: "#666", border: "none", cursor: "pointer", fontSize: 13, fontFamily: styles.font
                    }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Loading dots */}
        {loading && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>🏥</div>
            <div style={{ background: "white", border: "1px solid #f0f0f0", borderRadius: "4px 18px 18px 18px", padding: "12px 16px", display: "flex", gap: 5 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#ccc", animation: `bounce .8s ${i*.2}s infinite` }} />)}
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>

      {/* Input */}
      <div style={{ background: "white", borderTop: "1px solid #f0f0f0", padding: "14px 16px" }}>
        {listening && (
          <div style={{ textAlign: "center", fontSize: 12, color: "#ef4444", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444", display: "inline-block", animation: "pulse 1.2s infinite" }} />
            Escuchando...
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", background: "#f5f5f5", borderRadius: 16, padding: "8px 8px 8px 14px", border: listening ? "1px solid #ef4444" : "1px solid transparent", transition: "border .2s" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
            placeholder="Escribe o dicta los datos del paciente..."
            rows={1}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              fontSize: 14, fontFamily: styles.font, color: "#0a0a0a", resize: "none",
              lineHeight: 1.5, padding: "4px 0", maxHeight: 120, overflowY: "auto"
            }}
          />
          <div style={{ display: "flex", gap: 6", alignItems: "center" }}>
            <button onClick={toggleListening} style={{
              width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer",
              background: listening ? "#ef4444" : "#e5e5e5", color: listening ? "white" : "#666",
              fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all .2s", flexShrink: 0
            }}>
              {listening ? "⏹" : "🎙"}
            </button>
            <button onClick={() => sendMessage(input)} disabled={!input.trim() || loading} style={{
              width: 36, height: 36, borderRadius: 10, border: "none", cursor: input.trim() ? "pointer" : "default",
              background: input.trim() ? "#0a0a0a" : "#e5e5e5", color: input.trim() ? "white" : "#bbb",
              fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all .2s", flexShrink: 0
            }}>↑</button>
          </div>
        </div>
        <p style={{ textAlign: "center", fontSize: 11, color: "#ccc", margin: "10px 0 0" }}>Enter para enviar · Shift+Enter para nueva línea</p>
      </div>

      <style>{`
        @keyframes bounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)} }
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.3} }
        * { box-sizing: border-box; }
        textarea::placeholder { color: #bbb; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #e5e5e5; border-radius: 4px; }
      `}</style>
    </div>
  );
}
