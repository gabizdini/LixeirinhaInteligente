"""
Coletor MQTT -> CSV
Fica inscrito no tópico da lixeira e grava cada mensagem do ESP32 com data/hora.
Deixe rodando enquanto o ESP estiver enviando dados.

Mensagem esperada (JSON do ESP32):
  {"nivel":42.5,"distancia":9.8,"status":"QUASE_CHEIA"}
  (também aceita o formato antigo com "ocupacao" e "timestamp")

As configurações do broker vêm do arquivo .env (o mesmo do server.js).

Instalar:  pip install paho-mqtt
Rodar:     python coletor.py
"""
import time
import treinar
import csv
import json
import os
import unicodedata
from datetime import datetime
from urllib.parse import urlparse
import threading


def carregar_env(caminho=".env"):
    """Lê o arquivo .env (CHAVE=valor) e coloca em os.environ."""
    if not os.path.exists(caminho):
        return
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip()
            if linha and not linha.startswith("#") and "=" in linha:
                chave, valor = linha.split("=", 1)
                os.environ.setdefault(chave.strip(), valor.strip())


carregar_env()

# ===== CONFIGURAÇÃO (vem do .env) =====
_url = urlparse(os.environ.get("MQTT_URL", "mqtt://localhost:1883"))
MQTT_SERVER = _url.hostname
MQTT_TLS = _url.scheme in ("mqtts", "ssl")          # mqtts:// = conexão segura
MQTT_PORT = _url.port or (8883 if MQTT_TLS else 1883)
MQTT_USER = os.environ.get("MQTT_USERNAME") or None
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD") or None
TOPIC = os.environ.get("MQTT_TOPIC", "pinkbin/lixeira/dados")
TOPIC_PREVISAO = os.environ.get("MQTT_TOPIC_PREVISAO", "pinkbin/previsao")
ARQUIVO = "dados_lixeira.csv"
COLUNAS = ["data_hora", "estado", "ocupacao", "distancia", "bruto"]


def limpar(texto):
    t = unicodedata.normalize("NFD", str(texto).strip().lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def estado_por_ocupacao(n):
    """Mesmos limites do ESP32: >= 80 cheia, >= 50 atenção (metade)."""
    return "cheio" if n >= 80 else "metade" if n >= 50 else "normal"


def estado_por_texto(texto):
    t = limpar(texto)
    # "quase_cheia" precisa vir antes de "cheia" (senão viraria "cheio")
    if "quase" in t or "atencao" in t:
        return "metade"
    if "cheio" in t or "cheia" in t or "full" in t:
        return "cheio"
    if "atencao" in t or "metade" in t or "meio" in t or "half" in t:
        return "metade"
    if "normal" in t or "vazio" in t or "vazia" in t:
        return "normal"
    return ""


def para_numero(valor):
    try:
        return float(valor)
    except (TypeError, ValueError):
        return None


def interpretar(bruto):
    """Devolve (estado, ocupacao, distancia, timestamp_do_esp)."""
    try:
        d = json.loads(bruto)
    except ValueError:
        d = None

    if isinstance(d, dict):
        ocupacao = para_numero(d.get("nivel", d.get("ocupacao")))
        distancia = para_numero(d.get("distancia"))
        estado = estado_por_texto(d.get("status", ""))
        if not estado and ocupacao is not None:
            estado = estado_por_ocupacao(ocupacao)
        return estado, ocupacao, distancia, d.get("timestamp")

    # texto simples ou número
    estado = estado_por_texto(bruto)
    if estado:
        return estado, None, None, None
    n = para_numero(bruto)
    if n is not None:
        return estado_por_ocupacao(n), n, None, None
    return "", None, None, None


def data_hora(timestamp_esp):
    """Usa a hora enviada pelo ESP32 (NTP); se não vier, usa a do computador."""
    try:
        return datetime.strptime(timestamp_esp, "%Y-%m-%d %H:%M:%S").isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return datetime.now().isoformat(timespec="seconds")


def gravar(bruto):
    estado, ocupacao, distancia, ts = interpretar(bruto)
    linha = [
        data_hora(ts),
        estado,
        "" if ocupacao is None else ocupacao,
        "" if distancia is None else distancia,
        bruto,
    ]
    novo = not os.path.exists(ARQUIVO)
    with open(ARQUIVO, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if novo:
            w.writerow(COLUNAS)
        w.writerow(linha)
    return linha


def main():
    import paho.mqtt.client as mqtt

    def treinar_em_segundo_plano():
        try:
            treinar.treinar()
            with open("previsao.json", encoding="utf-8") as f:
                client.publish(TOPIC_PREVISAO, f.read(), qos=1, retain=True)
        except Exception as e:
            print("Treino falhou:", e)

    def ao_conectar(client, userdata, flags, reason_code, properties):
        print("Conectado:", reason_code)
        client.subscribe(TOPIC)
        threading.Thread(target=treinar_em_segundo_plano, daemon=True).start()
        
    def ao_desconectar(client, userdata, flags, reason_code, properties):
        print("Desconectado:", reason_code)   # mostra o motivo

    ultimo_treino = {"t": 0}


    def ao_receber(client, userdata, msg):
        linha = gravar(msg.payload.decode(errors="ignore"))
        print(*linha[:4])
        if time.time() - ultimo_treino["t"] > 600:
            ultimo_treino["t"] = time.time()
            threading.Thread(target=treinar_em_segundo_plano, daemon=True).start()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="pinkbin_coletor_python",   # ID único, diferente do ESP32
    )
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    if MQTT_TLS:
        client.tls_set()
    client.reconnect_delay_set(min_delay=1, max_delay=30)   # reconexão automática
    print("Conectando em", MQTT_SERVER, MQTT_PORT, "tópico", TOPIC)
    client.on_connect = ao_conectar
    client.on_disconnect = ao_desconectar
    client.on_message = ao_receber
    client.connect_async(MQTT_SERVER, MQTT_PORT, keepalive=60)
    client.loop_forever(retry_first_connection=True)   # tenta de novo se o broker estiver fora

if __name__ == "__main__":
    main()
