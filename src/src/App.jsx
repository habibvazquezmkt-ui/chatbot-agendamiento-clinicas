import { useState, useRef, useEffect } from "react";

const SYSTEM_PROMPT = `Eres un asistente virtual de agendamiento médico. Tu única función es ayudar a agendar pacientes extrayendo datos de los mensajes.

Cuando el usuario te dé información de un paciente, SIEMPRE responde ÚNICAMENTE con un JSON válido en este formato exacto:
{
  "action": "confirm",
  "data": {
    "nombre": "nombre completo del paciente",
    "fecha": "fecha en formato DD/MM/YYYY",
    "hora": "hora en formato HH:MM",
    "telefono": "teléfono de contacto"
  },
  "resumen": "mensaje amigable confirmando los datos al usuario"
}

Si faltan datos, responde con:
{
  "action": "missing",
  "faltante": ["lista de campos que faltan"],
  "resumen": "mensaje pidiendo los datos faltantes de forma amigable"
}

Si el usuario saluda o pregunta algo general, responde con:
{
  "action": "chat",
  "resumen": "tu respuesta normal"
}

Si el usuario confirma el agendamiento (dice sí, confirmar, correcto, etc.), responde con:
{
  "action": "save",
  "resumen": "mensaje de éxito"
}

Si el usuario quiere cancelar o empezar de nuevo, responde con:
{
  "action": "cancel",
  "resumen": "mensaje de cancelación"
}

Interpreta fechas relativas como "mañana", "el lunes", "próximo martes" usando el contexto. Hoy es ${new Date().toLocaleDateString("es-MX", {weekday:"long", year:"numeric", month:"long", day:"numeric"})}.
Siempre responde en español. No agregues nada fuera del JSON.`;

const defaultClinics = [
  { id: 1, name: "Clínica Principal", url: "" },
];

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

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const addMessage = (role, text, type = "text") => {
    setMessages(prev => [...prev, { role, text, type, id: Date.now() + Math.random() }]);
  };

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Tu navegador no soporta reconocimiento de voz. Usa Chrome."); return; }
    const r = recognitionRef.current = new SR();
    r.lang = "es-MX";
    r.continuous = false;
    r.interimResults = false;
    r.onstart = () => setListening(true);
    r.onresult = e => { setInput(e.results[0][0].transcript); setListening(false); };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
  };

  const stopListening = () => { recognitionRef.current?.stop(); setListening(false); };

  const sendToSheets = async (data, clinic) => {
    if (!clinic.url) return false;
    try {
      await fetch(clinic.url, {
        method: "POST",
        mode: "no-cors",
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
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: history,
        }),
      });
      const data = await res.json();
      const rawText = data.content?.[0]?.text || "{}";
      let parsed;
      try { parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim()); }
      catch { parsed = { action: "chat", resumen: rawText }; }

      if (parsed.action === "confirm" && parsed.data) {
        setPendingData(parsed.data);
        setMessages(prev => [...prev, {
          role: "assistant", text: parsed.resumen, type: "confirm",
          data: parsed.data, rawText, id: Date.now()
        }]);
      } else if (parsed.action === "save" && pendingData) {
        setSaving(true);
        const ok = await sendToSheets(pendingData, selectedClinic);
        setSaving(false);
        const msg = ok
          ? `✅ ¡Listo! ${pendingData.nombre} fue agendado/a el ${pendingData.fecha} a las ${pendingData.hora}.`
          : `✅ Datos registrados${selectedClinic.url ? " (revisa la conexión con Sheets)" : " (no hay URL de Sheets configurada)"}.`;
        addMessage("assistant", msg);
        setPendingData(null);
      } else if (parsed.action === "cancel") {
        setPendingData(null);
        addMessage("assistant", parsed.resumen || "Agendamiento cancelado. ¿En qué más puedo ayudarte?");
      } else {
        addMessage("assistant", parsed.resumen || "Entendido.");
      }
    } catch (e) {
      addMessage("assistant", "Hubo un error al procesar tu mensaje. Intenta de nuevo.");
    }
    setLoading(false);
  };

  const confirmSave = () => sendMessage("sí, confirmar");
  const cancelSave = () => sendMessage("cancelar");

  const startChat = (clinic) => {
    setSelectedClinic(clinic);
    setView("chat");
    setMessages([{
      role: "assistant",
      text: `¡Hola! Soy tu asistente de agendamiento para ${clinic.name}. 😊\n\nPuedes decirme o escribir los datos del paciente. Por ejemplo:\n"Agendar a María López el viernes a las 10am, teléfono 664-123-4567"`,
      type: "text", id: Date.now()
    }]);
  };

  const addClinic = () => {
    if (!newClinicName.trim()) return;
    setClinics(prev => [...prev, { id: Date.now(), name: newClinicName, url: newClinicUrl }]);
    setNewClinicName(""); setNewClinicUrl("");
  };

  const updateClinicUrl = (id, url) =>
    setClinics(prev => prev.map(c => c.id === id ? { ...c, url } : c));

  // SETUP VIEW
  if (view === "setup") return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0f172a,#1e3a5f)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 20 }}>
      <div style={{ background: "white", borderRadius: 20, padding: 40, maxWidth: 480, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48 }}>🏥</div>
          <h1 style={{ margin: "8px 0 4px", color: "#0f172a", fontSize: 24 }}>Agendamiento de Pacientes</h1>
          <p style={{ color: "#64748b", margin: 0, fontSize: 14 }}>Selecciona la clínica para comenzar</p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
          {clinics.map(c => (
            <button key={c.id} onClick={() => startChat(c)}
              style={{ padding: "14px 20px", borderRadius: 12, border: "2px solid #e2e8f0", background: "white", cursor: "pointer", textAlign: "left", fontSize: 15, fontWeight: 600, color: "#0f172a", display: "flex", alignItems: "center", gap: 10 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#3b82f6"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#e2e8f0"}>
              <span style={{ fontSize: 20 }}>🏨</span>
              <div>
                <div>{c.name}</div>
                <div style={{ fontSize: 11, fontWeight: 400, color: c.url ? "#22c55e" : "#f59e0b" }}>
                  {c.url ? "✓ Conectada a Sheets" : "⚠ Sin URL de Sheets"}
                </div>
              </div>
            </button>
          ))}
        </div>

        <button onClick={() => setConfigOpen(!configOpen)}
          style={{ width: "100%", padding: "10px", borderRadius: 10, border: "1px dashed #cbd5e1", background: "#f8fafc", cursor: "pointer", color: "#475569", fontSize: 14 }}>
          ⚙️ Configurar clínicas y URLs de Sheets
        </button>

        {configOpen && (
          <div style={{ marginTop: 16, padding: 16, background: "#f8fafc", borderRadius: 12, fontSize: 13 }}>
            <p style={{ margin: "0 0 12px", fontWeight: 600, color: "#374151" }}>URLs de Google Apps Script:</p>
            {clinics.map(c => (
              <div key={c.id} style={{ marginBottom: 10 }}>
                <label style={{ display: "block", marginBottom: 4, color: "#374151" }}>{c.name}</label>
                <input value={c.url} onChange={e => updateClinicUrl(c.id, e.target.value)}
                  placeholder="https://script.google.com/macros/s/..."
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12, boxSizing: "border-box" }} />
              </div>
            ))}
            <hr style={{ margin: "16px 0", borderColor: "#e2e8f0" }} />
            <p style={{ margin: "0 0 8px", fontWeight: 600, color: "#374151" }}>Agregar clínica:</p>
            <input value={newClinicName} onChange={e => setNewClinicName(e.target.value)}
              placeholder="Nombre de la clínica"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
            <input value={newClinicUrl} onChange={e => setNewClinicUrl(e.target.value)}
              placeholder="URL del Apps Script (opcional)"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
            <button onClick={addClinic}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "white", border: "none", cursor: "pointer", fontSize: 13 }}>
              + Agregar
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // CHAT VIEW
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#f1f5f9", fontFamily: "system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(90deg,#1e40af,#3b82f6)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 2px 8px rgba(0,0,0,.2)" }}>
        <button onClick={() => setView("setup")}
          style={{ background: "rgba(255,255,255,.2)", border: "none", color: "white", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 16 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ color: "white", fontWeight: 700, fontSize: 16 }}>🏥 {selectedClinic?.name}</div>
          <div style={{ color: "rgba(255,255,255,.75)", fontSize: 12 }}>Asistente de Agendamiento</div>
        </div>
        <div style={{ background: "rgba(255,255,255,.15)", borderRadius: 20, padding: "4px 12px", color: "white", fontSize: 12 }}>
          {new Date().toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" })}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map(m => (
          <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ maxWidth: "80%" }}>
              {m.role === "assistant" && (
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4, marginLeft: 4 }}>Asistente</div>
              )}
              <div style={{
                padding: "12px 16px",
                borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                background: m.role === "user" ? "linear-gradient(135deg,#3b82f6,#1d4ed8)" : "white",
                color: m.role === "user" ? "white" : "#1e293b",
                boxShadow: "0 2px 8px rgba(0,0,0,.08)",
                fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap"
              }}>
                {m.text}
              </div>

              {/* Confirm card */}
              {m.type === "confirm" && m.data && pendingData && (
                <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: 14, marginTop: 8 }}>
                  <p style={{ margin: "0 0 10px", fontWeight: 600, color: "#166534", fontSize: 13 }}>📋 Confirmar cita:</p>
                  <div style={{ fontSize: 13, color: "#374151", display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
                    <div>👤 <b>Paciente:</b> {m.data.nombre}</div>
                    <div>📅 <b>Fecha:</b> {m.data.fecha}</div>
                    <div>🕐 <b>Hora:</b> {m.data.hora}</div>
                    <div>📞 <b>Teléfono:</b> {m.data.telefono}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={confirmSave} disabled={saving}
                      style={{ flex: 1, padding: "8px", borderRadius: 8, background: "#22c55e", color: "white", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                      {saving ? "Guardando..." : "✓ Confirmar"}
                    </button>
                    <button onClick={cancelSave}
                      style={{ flex: 1, padding: "8px", borderRadius: 8, background: "#f1f5f9", color: "#64748b", border: "1px solid #e2e8f0", cursor: "pointer", fontSize: 13 }}>
                      ✗ Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 6, padding: "12px 16px" }}>
            {[0,1,2].map(i => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: "#94a3b8", animation: `bounce .8s ${i*.2}s infinite` }} />
            ))}
          </div>
        )}
        <div ref={messagesEnd} />
      </div>

      {/* Input */}
      <div style={{ background: "white", padding: "12px 16px", borderTop: "1px solid #e2e8f0", display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onMouseDown={startListening} onMouseUp={stopListening}
          onTouchStart={startListening} onTouchEnd={stopListening}
          style={{
            width: 44, height: 44, borderRadius: "50%", border: "none", cursor: "pointer", fontSize: 20, flexShrink: 0,
            background: listening ? "linear-gradient(135deg,#ef4444,#dc2626)" : "linear-gradient(135deg,#3b82f6,#1d4ed8)",
            color: "white", boxShadow: listening ? "0 0 0 6px rgba(239,68,68,.25)" : "none", transition: "all .2s"
          }}>
          {listening ? "⏹" : "🎙"}
        </button>
        <input
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage(input)}
          placeholder={listening ? "Escuchando..." : "Escribe o usa el micrófono..."}
          style={{ flex: 1, padding: "12px 16px", borderRadius: 24, border: "1px solid #e2e8f0", fontSize: 14, outline: "none", background: "#f8fafc" }} />
        <button onClick={() => sendMessage(input)} disabled={!input.trim() || loading}
          style={{
            width: 44, height: 44, borderRadius: "50%", border: "none", cursor: "pointer", fontSize: 20, flexShrink: 0,
            background: input.trim() ? "linear-gradient(135deg,#3b82f6,#1d4ed8)" : "#e2e8f0",
            color: input.trim() ? "white" : "#94a3b8"
          }}>
          ➤
        </button>
      </div>
      <style>{`@keyframes bounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)} }`}</style>
    </div>
  );
}
