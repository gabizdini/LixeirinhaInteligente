// =====================================================
// PinkBin - Dashboard (navegador)
// Os dados chegam do backend (server.js) via Socket.IO.
// O navegador NÃO conecta direto no MQTT e não guarda nenhuma senha:
// as configurações do broker ficam só no arquivo .env do servidor.
// =====================================================

// =====================================================
// ESTADOS DA LIXEIRA
// =====================================================
const ESTADOS = {
    normal: { rotulo: "Normal", nivel: 15,  texto: "txt-normal" },
    metade: { rotulo: "Metade", nivel: 55,  texto: "txt-metade" },
    cheio:  { rotulo: "Cheio",  nivel: 100, texto: "txt-cheio"  }
};

// Status enviado pela ESP32 -> estado usado no dashboard
const STATUS_PARA_ESTADO = {
    NORMAL: "normal",
    QUASE_CHEIA: "metade",
    CHEIA: "cheio"
};

const MAX_HISTORICO = 200;   // máximo salvo no navegador
const LINHAS_TABELA = 15;    // linhas mostradas na tela

let historico = carregarHistorico();

// =====================================================
// ATUALIZA A TELA
// dados = { estado, ocupacao, distancia }
// =====================================================
function mostrarLeitura(dados, textoBruto, dataHora) {
    const info = ESTADOS[dados.estado];

    // Se veio a ocupação real (%), a lixeira enche de acordo com ela
    const altura = dados.ocupacao != null ? dados.ocupacao : info.nivel;

    const nivel = document.getElementById("nivel");
    nivel.className = "lixeira-nivel " + dados.estado;
    nivel.style.height = altura + "%";

    const elEstado = document.getElementById("estado");
    elEstado.innerText = info.rotulo;
    elEstado.className = "estado-texto mt-4 " + info.texto;

    document.getElementById("ultimaAtualizacao").innerText = new Date(dataHora).toLocaleString("pt-BR");
    if (textoBruto != null) document.getElementById("mensagem").innerText = textoBruto;
    document.getElementById("ocupacao").innerText =
        dados.ocupacao != null ? Math.floor(dados.ocupacao) + "%" : "--"; // floor: 79,6% mostra 79% (ainda Metade)
    document.getElementById("distancia").innerText =
        dados.distancia != null ? dados.distancia.toFixed(1) + " cm" : "--";
}

function atualizarEstado(dados, textoBruto, origem, dataHora) {
    const data = dataHora || new Date().toISOString();
    mostrarLeitura(dados, textoBruto, data);

    historico.unshift({
        data: data,
        estado: dados.estado,
        ocupacao: dados.ocupacao != null ? dados.ocupacao : null,
        distancia: dados.distancia != null ? dados.distancia : null,
        origem: origem
    });
    historico = historico.slice(0, MAX_HISTORICO);
    salvarHistorico();
    desenharHistorico();
}

function desenharHistorico() {
    const corpo = document.getElementById("historico");
    corpo.innerHTML = "";

    if (historico.length === 0) {
        corpo.innerHTML = '<tr><td colspan="4" class="text-muted">Sem leituras ainda</td></tr>';
    }

    historico.slice(0, LINHAS_TABELA).forEach((item) => {
        const info = ESTADOS[item.estado];
        const tr = document.createElement("tr");
        tr.innerHTML =
            "<td>" + new Date(item.data).toLocaleString("pt-BR") + "</td>" +
            '<td class="fw-bold ' + info.texto + '">' + info.rotulo + "</td>" +
            "<td>" + (item.ocupacao != null ? Math.floor(item.ocupacao) + "%" : "-") + "</td>" +
            "<td>" + item.origem + "</td>";
        corpo.appendChild(tr);
    });

    document.getElementById("contNormal").innerText = historico.filter(h => h.estado === "normal").length;
    document.getElementById("contMetade").innerText = historico.filter(h => h.estado === "metade").length;
    document.getElementById("contCheio").innerText  = historico.filter(h => h.estado === "cheio").length;
}

function definirStatus(texto, classe) {
    const el = document.getElementById("status");
    el.innerText = texto;
    el.className = "badge " + classe;
}

function definirDispositivo(texto, classe) {
    const el = document.getElementById("dispositivo");
    el.innerText = texto;
    el.className = "badge " + classe;
}

// Aviso na tela com o motivo do problema (some quando está tudo certo)
function mostrarDiagnostico(texto) {
    const el = document.getElementById("diagnostico");
    el.innerText = texto;
    el.style.display = texto ? "block" : "none";
}

// Pisca o selo da ESP32 quando chega uma leitura nova
function piscarDispositivo() {
    const el = document.getElementById("dispositivo");
    el.classList.remove("pulsar");
    void el.offsetWidth; // reinicia a animação
    el.classList.add("pulsar");
}

// =====================================================
// PREVISÃO DE COLETA (publicada pelo coletor.py via MQTT)
// =====================================================
function formatarPrevisao(iso) {
    const d = new Date(iso);
    const horas = (d - new Date()) / 3600000;
    const quando = d.toLocaleString("pt-BR", {
        weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    });
    if (horas <= 0) return quando + " (agora!)";
    return quando + " (em ~" + horas.toFixed(1) + " h)";
}

function mostrarPrevisao(p) {
    const principal = document.getElementById("prevPrincipal");
    const detalhe = document.getElementById("prevDetalhe");

    if (!p.pronto) {
        principal.innerText = "--";
        detalhe.innerText = p.motivo || "Ainda sem previsão";
        return;
    }
    principal.innerText = p.horario_cheia
        ? "Retirar até " + formatarPrevisao(p.horario_cheia)
        : "Não deve encher nos próximos 7 dias";

    let txt = "";
    if (p.horario_metade) txt += "🌷 Metade: " + formatarPrevisao(p.horario_metade) + " · ";
    txt += "Ritmo: " + p.taxa_media_por_hora + "%/h · " + p.amostras +
        " amostras · Confiança: " + p.confianca;
    detalhe.innerText = txt;
}

// =====================================================
// HISTÓRICO NO NAVEGADOR (localStorage)
// =====================================================
function carregarHistorico() {
    try {
        return JSON.parse(localStorage.getItem("historicoLixeira")) || [];
    } catch (e) {
        return [];
    }
}

function salvarHistorico() {
    try {
        localStorage.setItem("historicoLixeira", JSON.stringify(historico));
    } catch (e) { /* ignora */ }
}

// Exporta CSV (útil depois para treinar o modelo de ML)
function exportarCsv() {
    const linhas = ["data_hora,estado,ocupacao,origem,distancia"];
    historico.slice().reverse().forEach((h) => {
        const oc = h.ocupacao != null ? h.ocupacao : "";
        const di = h.distancia != null ? h.distancia : "";
        linhas.push(h.data + "," + h.estado + "," + oc + "," + h.origem + "," + di);
    });
    const blob = new Blob([linhas.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "historico_lixeira.csv";
    a.click();
    URL.revokeObjectURL(a.href);
}

document.getElementById("btnCsv").addEventListener("click", exportarCsv);
document.getElementById("btnLimpar").addEventListener("click", () => {
    historico = [];
    salvarHistorico();
    desenharHistorico();
});

// Botões do modo teste (só mudam a tela, não enviam nada para a ESP32)
document.querySelectorAll("[data-teste]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const estado = btn.getAttribute("data-teste");
        atualizarEstado({ estado: estado, ocupacao: null, distancia: null }, estado, "teste");
    });
});

desenharHistorico();

// Mostra a última leitura salva enquanto não chega mensagem nova
if (historico.length > 0) {
    const ult = historico[0];
    mostrarLeitura(ult, null, ult.data);
}

// =====================================================
// CONEXÃO COM O BACKEND (Socket.IO)
// =====================================================
// Converte a leitura que vem do servidor para o formato do dashboard
function paraDados(leitura) {
    return {
        estado: STATUS_PARA_ESTADO[leitura.status] || "normal",
        ocupacao: leitura.nivel,
        distancia: leitura.distancia
    };
}

if (typeof io === "undefined") {
    definirStatus("Servidor não encontrado", "bg-danger");
    definirDispositivo("ESP32: sem informação", "bg-secondary");
    mostrarDiagnostico("Abra o dashboard pelo servidor: rode \"npm start\" e acesse http://localhost:3000 (não abra o index.html direto).");
} else {
    let timeoutDispositivo = 30;
    let conectadoAoServidor = false;

    // O Socket.IO reconecta sozinho se o servidor cair
    const socket = io({ reconnectionDelay: 2000, reconnectionDelayMax: 10000 });

    socket.on("connect", () => {
        conectadoAoServidor = true;
        console.log("Conectado ao servidor do dashboard");
    });

    socket.on("disconnect", () => {
        conectadoAoServidor = false;
        definirStatus("Servidor offline", "bg-danger");
        definirDispositivo("ESP32: sem informação", "bg-secondary");
        mostrarDiagnostico("Perdi a conexão com o servidor do dashboard. Confira se o \"npm start\" está rodando. Tentando reconectar...");
    });

    socket.on("connect_error", () => {
        if (!conectadoAoServidor) {
            definirStatus("Servidor offline", "bg-danger");
            mostrarDiagnostico("Não consegui falar com o servidor do dashboard. Confira se o \"npm start\" está rodando. Tentando reconectar...");
        }
    });

    socket.on("config", (cfg) => {
        timeoutDispositivo = cfg.timeoutDispositivo;
    });

    // Situação do MQTT e da ESP32 (enviada pelo servidor sempre que muda)
    socket.on("status", (s) => {
        // 1) Conexão do servidor com o broker MQTT
        if (s.mqtt === "conectado") {
            definirStatus("MQTT conectado", "bg-success");
        } else if (s.mqtt === "reconectando" || s.mqtt === "conectando") {
            definirStatus("Reconectando ao MQTT...", "bg-warning text-dark");
        } else {
            definirStatus("MQTT desconectado", "bg-danger");
        }

        // 2) ESP32 enviando dados?
        if (s.mqtt !== "conectado") {
            definirDispositivo("ESP32: sem informação", "bg-secondary");
            mostrarDiagnostico("O servidor não está conectado ao broker MQTT" +
                (s.erro ? " (" + s.erro + ")" : "") +
                ". Confira se o container do HiveMQ está rodando no Docker. Tentando reconectar a cada 5 s...");
        } else if (s.dispositivo === "online") {
            definirDispositivo("ESP32 online", "bg-success");
            mostrarDiagnostico("");
        } else if (s.dispositivo === "offline") {
            definirDispositivo("ESP32 desconectada", "bg-danger");
            mostrarDiagnostico("Nenhum dado da ESP32 há mais de " + timeoutDispositivo +
                " s. Confira se ela está ligada e conectada ao Wi-Fi. A tela mostra a última leitura recebida.");
        } else {
            definirDispositivo("ESP32: aguardando dados", "bg-warning text-dark");
            mostrarDiagnostico(s.erro ? "Aviso do servidor: " + s.erro : "");
        }
    });

    // Leitura nova da ESP32
    socket.on("leitura", (leitura) => {
        atualizarEstado(paraDados(leitura), leitura.bruto, "esp32", leitura.recebidoEm);
        piscarDispositivo();
    });

    // Última leitura conhecida (enviada ao abrir/recarregar a página)
    socket.on("ultimaLeitura", (leitura) => {
        const jaSalva = historico.some((h) => h.data === leitura.recebidoEm);
        if (jaSalva) {
            mostrarLeitura(paraDados(leitura), leitura.bruto, leitura.recebidoEm);
        } else {
            atualizarEstado(paraDados(leitura), leitura.bruto, "esp32", leitura.recebidoEm);
        }
    });

    socket.on("mensagemInvalida", (texto) => {
        document.getElementById("mensagem").innerText = texto + " (formato desconhecido)";
    });

    socket.on("previsao", mostrarPrevisao);
}
