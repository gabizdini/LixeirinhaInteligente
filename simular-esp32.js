// =====================================================
// Simulador da ESP32 (só para testes, sem precisar da placa)
// Publica no broker o mesmo JSON que a ESP32 envia.
//
// Rodar (em outro terminal, com o "npm start" já rodando):
//   npm run simular
// Pare com Ctrl+C -> após DEVICE_TIMEOUT_S segundos o dashboard
// deve mostrar "ESP32 desconectada".
// =====================================================
require("dotenv").config();
const mqtt = require("mqtt");

const ALTURA_LIXEIRA_CM = 15; // mesma altura usada na ESP32
const TOPICO = process.env.MQTT_TOPIC || "pinkbin/lixeira/dados";

const client = mqtt.connect(process.env.MQTT_URL, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: "pinkbin_simulador_" + Math.random().toString(16).slice(2, 8)
});

let nivel = 0;

client.on("connect", () => {
    console.log("Simulador conectado. Publicando em", TOPICO, "a cada 3 s (Ctrl+C para parar)");

    setInterval(() => {
        nivel += 4 + Math.random() * 4;     // a lixeira vai enchendo
        if (nivel > 100) nivel = 0;          // "esvaziou"

        const distancia = ALTURA_LIXEIRA_CM * (1 - nivel / 100);
        const status = nivel >= 80 ? "CHEIA" : nivel >= 50 ? "QUASE_CHEIA" : "NORMAL";

        const mensagem = JSON.stringify({
            nivel: Number(nivel.toFixed(1)),
            distancia: Number(distancia.toFixed(1)),
            status: status
        });
        client.publish(TOPICO, mensagem);
        console.log("Enviado:", mensagem);
    }, 3000);
});

client.on("error", (e) => console.error("Erro:", e.message));
