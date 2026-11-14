// =====================================================
// PinkBin - Backend
// Recebe as mensagens MQTT da ESP32 e repassa ao dashboard
// em tempo real usando Socket.IO.
//
//   ESP32 --MQTT--> HiveMQ (Docker) --MQTT--> server.js --Socket.IO--> navegador
//
// Rodar:  npm start   (depois abra http://localhost:3000)
// =====================================================
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const mqtt = require("mqtt");

// ---------- Configurações (vêm do arquivo .env) ----------
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
const MQTT_TOPIC = process.env.MQTT_TOPIC || "pinkbin/lixeira/dados";
const MQTT_TOPIC_PREVISAO = process.env.MQTT_TOPIC_PREVISAO || "pinkbin/previsao";
const DEVICE_TIMEOUT_S = Number(process.env.DEVICE_TIMEOUT_S) || 30;
const PORT = Number(process.env.PORT) || 3000;

if (!MQTT_URL) {
    console.error("ERRO: MQTT_URL não definido. Copie .env.example para .env e preencha.");
    process.exit(1);
}

// ---------- Servidor web ----------
// Só entrega os arquivos do dashboard. O resto da pasta (.env, .csv, .py)
// NÃO fica acessível pelo navegador.
const app = express();
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/app.js", (req, res) => res.sendFile(path.join(__dirname, "app.js")));

const server = http.createServer(app);
const io = new Server(server);

// ---------- Estado atual (enviado para quem abrir o dashboard) ----------
const estado = {
    mqtt: "conectando",        // conectando | conectado | reconectando | desconectado
    dispositivo: "aguardando", // aguardando | online | offline
    ultimaMensagemEm: null,    // data/hora (ISO) da última leitura válida
    erro: null
};
let ultimaLeitura = null;
let ultimaPrevisao = null;

function enviarStatus() {
    io.emit("status", estado);
}

// ---------- Validação da mensagem da ESP32 ----------
// Esperado: {"nivel":42.5,"distancia":9.8,"status":"QUASE_CHEIA"}
// Também aceita "ocupacao" no lugar de "nivel" (formato antigo).
function normalizarStatus(valor) {
    const t = String(valor || "")
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")  // remove acentos
        .replace(/[\s-]+/g, "_");          // "quase cheia" -> "QUASE_CHEIA"
    if (t === "CHEIA" || t === "CHEIO") return "CHEIA";
    if (t === "QUASE_CHEIA" || t === "ATENCAO" || t === "METADE") return "QUASE_CHEIA";
    if (t === "NORMAL" || t === "VAZIA") return "NORMAL";
    return null;
}

function statusPorNivel(nivel) {
    if (nivel >= 80) return "CHEIA";
    if (nivel >= 50) return "QUASE_CHEIA";
    return "NORMAL";
}

function numeroOuNull(v) {
    const n = Number(v);
    return v === null || v === undefined || v === "" || !isFinite(n) ? null : n;
}

function interpretarLeitura(texto) {
    let d;
    try {
        d = JSON.parse(texto);
    } catch (e) {
        return null;
    }
    if (d === null || typeof d !== "object") return null;

    let nivel = numeroOuNull(d.nivel !== undefined ? d.nivel : d.ocupacao);
    const distancia = numeroOuNull(d.distancia);
    if (nivel !== null) nivel = Math.min(100, Math.max(0, nivel)); // limita entre 0 e 100

    let status = normalizarStatus(d.status);
    if (!status && nivel !== null) status = statusPorNivel(nivel);
    if (!status) return null;

    return {
        nivel: nivel,
        distancia: distancia !== null && distancia >= 0 ? distancia : null,
        status: status,
        recebidoEm: new Date().toISOString(),
        bruto: texto
    };
}

// ---------- Conexão MQTT (com reconexão automática) ----------
const client = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: "pinkbin_dashboard_" + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 5000,   // tenta reconectar a cada 5 s
    connectTimeout: 10000,
    keepalive: 30
});

client.on("connect", () => {
    console.log("[MQTT] Conectado ao broker");
    estado.mqtt = "conectado";
    estado.erro = null;
    enviarStatus();

    client.subscribe([MQTT_TOPIC, MQTT_TOPIC_PREVISAO], (erro, granted) => {
        if (erro || (granted && granted.some((g) => g.qos === 128))) {
            estado.erro = "Sem permissão para assinar os tópicos";
            console.error("[MQTT] Falha ao assinar tópicos", erro || granted);
            enviarStatus();
            return;
        }
        console.log("[MQTT] Inscrito em:", MQTT_TOPIC, "e", MQTT_TOPIC_PREVISAO);
    });
});

client.on("reconnect", () => {
    console.log("[MQTT] Reconectando...");
    estado.mqtt = "reconectando";
    enviarStatus();
});

client.on("close", () => {
    if (estado.mqtt === "conectado") console.log("[MQTT] Conexão perdida");
    if (estado.mqtt !== "reconectando") estado.mqtt = "desconectado";
    enviarStatus();
});

client.on("error", (erro) => {
    const msg = erro.code === "ECONNREFUSED"
        ? "broker recusou a conexão (o container está rodando?)"
        : erro.message || erro.code || String(erro);
    console.error("[MQTT] Erro:", msg);
    estado.erro = msg;
    enviarStatus();
});

client.on("message", (topico, payload) => {
    const texto = payload.toString().slice(0, 1024); // ignora mensagens gigantes

    if (topico === MQTT_TOPIC_PREVISAO) {
        try {
            ultimaPrevisao = JSON.parse(texto);
            io.emit("previsao", ultimaPrevisao);
        } catch (e) {
            console.warn("[MQTT] Previsão inválida:", texto);
        }
        return;
    }

    const leitura = interpretarLeitura(texto);
    if (!leitura) {
        console.warn("[MQTT] Mensagem em formato desconhecido:", texto);
        io.emit("mensagemInvalida", texto);
        return;
    }

    console.log("[MQTT] Leitura:", leitura.status, leitura.nivel + "%", leitura.distancia + " cm");
    ultimaLeitura = leitura;
    estado.ultimaMensagemEm = leitura.recebidoEm;
    if (estado.dispositivo !== "online") {
        estado.dispositivo = "online";
        enviarStatus();
    }
    io.emit("leitura", leitura);
});

// ---------- Detecta ESP32 desconectada ----------
// Se passar DEVICE_TIMEOUT_S segundos sem leitura, marca como offline.
setInterval(() => {
    if (estado.dispositivo !== "online" || !estado.ultimaMensagemEm) return;
    const segundos = (Date.now() - new Date(estado.ultimaMensagemEm).getTime()) / 1000;
    if (segundos > DEVICE_TIMEOUT_S) {
        console.log("[ESP32] Sem dados há " + Math.round(segundos) + " s, marcando como offline");
        estado.dispositivo = "offline";
        enviarStatus();
    }
}, 2000);

// ---------- Previsão também pelo arquivo previsao.json ----------
// Assim a previsão aparece mesmo que a mensagem MQTT do coletor.py
// tenha sido perdida (ex.: servidor iniciado depois, broker reiniciado).
const ARQUIVO_PREVISAO = path.join(__dirname, "previsao.json");

function carregarPrevisaoDoArquivo() {
    try {
        const p = JSON.parse(fs.readFileSync(ARQUIVO_PREVISAO, "utf-8"));
        // só usa o arquivo se ele for mais novo que a previsão que já temos
        if (!ultimaPrevisao || (p.gerado_em || "") > (ultimaPrevisao.gerado_em || "")) {
            ultimaPrevisao = p;
            io.emit("previsao", ultimaPrevisao);
            console.log("[Previsão] Carregada de previsao.json (gerada em " + p.gerado_em + ")");
        }
    } catch (e) {
        // arquivo ainda não existe ou está sendo escrito: tenta de novo depois
    }
}

carregarPrevisaoDoArquivo();
fs.watchFile(ARQUIVO_PREVISAO, { interval: 5000 }, carregarPrevisaoDoArquivo);

// ---------- Quando um navegador abre o dashboard ----------
io.on("connection", (socket) => {
    socket.emit("config", { timeoutDispositivo: DEVICE_TIMEOUT_S, topico: MQTT_TOPIC });
    socket.emit("status", estado);
    if (ultimaLeitura) socket.emit("ultimaLeitura", ultimaLeitura);
    if (ultimaPrevisao) socket.emit("previsao", ultimaPrevisao);
});

server.listen(PORT, () => {
    console.log("Dashboard em http://localhost:" + PORT);
    console.log("Broker MQTT: " + MQTT_URL.replace(/\/\/.*@/, "//***@")); // não mostra senha
});
