// =====================================================
// PinkBin - ESP32 + HC-SR04 + Buzzer -> MQTT (HiveMQ local no Docker)
// Publica em "pinkbin/lixeira/dados":
//   {"nivel":42.50,"distancia":10.62,"status":"NORMAL","timestamp":"2026-11-14 19:30:00"}
//   status: NORMAL | QUASE_CHEIA | CHEIA
//
// Wi-Fi e broker ficam em "secrets.h" (não vai para o GitHub).
// Biblioteca necessária: PubSubClient (Nick O'Leary)
// =====================================================
#include <WiFi.h>
#include <PubSubClient.h>
#include <time.h>
#include "secrets.h"

// -------------------------------
// PINOS
// -------------------------------
#define TRIG_PIN 5
#define ECHO_PIN 18
#define BUZZER_PIN 19

// -------------------------------
// CALIBRACAO DA LIXEIRA
// -------------------------------
const float DISTANCIA_VAZIA = 15.18;
const float DISTANCIA_CHEIA = 4.44;

// Topico para envio dos dados
const char* MQTT_TOPIC = "pinkbin/lixeira/dados";

// -------------------------------
// CONEXAO MQTT
// O HiveMQ local (porta 1883) nao usa TLS, entao usamos WiFiClient comum
// (WiFiClientSecure so funciona com brokers TLS, como o HiveMQ Cloud).
// -------------------------------
WiFiClient espClient;
PubSubClient client(espClient);

unsigned long ultimaTentativaMQTT = 0;

// -------------------------------
// CONECTAR AO WIFI
// -------------------------------
void conectarWiFi() {

  Serial.println("Conectando ao Wi-Fi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Espera no maximo 20 s; se nao conectar, tenta de novo no proximo loop
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[OK] Wi-Fi conectado!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[ERRO] Wi-Fi nao conectou, tentando de novo...");
  }
}

// -------------------------------
// CONECTAR AO HIVEMQ
// Tenta no maximo a cada 3 s, sem travar o loop
// (assim o sensor e o buzzer continuam funcionando sem broker).
// -------------------------------
void conectarMQTT() {

  if (client.connected() || millis() - ultimaTentativaMQTT < 3000) {
    return;
  }
  ultimaTentativaMQTT = millis();

  Serial.print("Conectando ao HiveMQ em ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);

  bool conectado;
  if (strlen(MQTT_USER) > 0) {
    conectado = client.connect("PinkBinESP32", MQTT_USER, MQTT_PASSWORD);
  } else {
    conectado = client.connect("PinkBinESP32");  // broker sem usuario/senha
  }

  if (conectado) {
    Serial.println("[OK] Conectado ao HiveMQ!");
  } else {
    // -2 = nao achou o broker (IP errado, Docker parado ou firewall)
    // 4/5 = usuario/senha incorretos ou sem permissao
    Serial.print("[ERRO] MQTT: ");
    Serial.println(client.state());
  }
}

// -------------------------------
// MEDIR DISTANCIA (media de 5 leituras)
// -------------------------------
float medirDistancia() {

  float soma = 0;
  int leiturasValidas = 0;

  for (int i = 0; i < 5; i++) {

    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(3);

    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);

    digitalWrite(TRIG_PIN, LOW);

    long duracao = pulseIn(ECHO_PIN, HIGH, 50000);

    if (duracao > 0) {

      float distancia = duracao * 0.0343 / 2;

      if (distancia >= 2 && distancia <= 400) {
        soma += distancia;
        leiturasValidas++;
      }
    }

    delay(60);
  }

  if (leiturasValidas < 3) {
    return -1;
  }

  return soma / leiturasValidas;
}

// -------------------------------
// OBTER DATA E HORA
// -------------------------------
void obterDataHora(char* resultado, size_t tamanho) {

  struct tm informacaoTempo;

  if (getLocalTime(&informacaoTempo, 10)) {

    strftime(resultado, tamanho, "%Y-%m-%d %H:%M:%S",
             &informacaoTempo);

  } else {

    snprintf(resultado, tamanho, "indisponivel");
  }
}

// -------------------------------
// ENVIAR DADOS AO HIVEMQ
// -------------------------------
void enviarDados(float distancia, float nivel,
                 const char* status) {

  if (!client.connected()) {
    Serial.println("[AVISO] MQTT desconectado, leitura nao enviada.");
    return;
  }

  char dataHora[25];
  obterDataHora(dataHora, sizeof(dataHora));

  char mensagem[256];

  snprintf(mensagem, sizeof(mensagem),
    "{\"nivel\":%.2f,\"distancia\":%.2f,\"status\":\"%s\",\"timestamp\":\"%s\"}",
    nivel, distancia, status, dataHora);

  if (client.publish(MQTT_TOPIC, mensagem)) {

    Serial.println("[OK] Dados enviados ao HiveMQ!");
    Serial.println(mensagem);

  } else {

    Serial.println("[ERRO] Falha ao enviar dados MQTT!");
  }
}

// -------------------------------
// CONFIGURACAO INICIAL
// -------------------------------
void setup() {

  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(TRIG_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  Serial.println("==============================");
  Serial.println("       PINKBIN INICIADA");
  Serial.println("==============================");

  conectarWiFi();

  // Horario de Brasilia: UTC-3
  configTime(-3 * 3600, 0,
             "pool.ntp.org",
             "time.cloudflare.com");

  client.setServer(MQTT_HOST, MQTT_PORT);
  client.setBufferSize(256);
  client.setKeepAlive(15);

  conectarMQTT();
}

// -------------------------------
// LOOP PRINCIPAL
// -------------------------------
void loop() {

  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  }

  conectarMQTT();
  client.loop();

  float distancia = medirDistancia();

  if (distancia < 0) {

    Serial.println("[ERRO] Falha na leitura do sensor!");
    digitalWrite(BUZZER_PIN, LOW);

  } else {

    float nivel =
      ((DISTANCIA_VAZIA - distancia) /
      (DISTANCIA_VAZIA - DISTANCIA_CHEIA)) * 100;

    nivel = constrain(nivel, 0, 100);

    const char* status;

    Serial.println("------------------------------");

    Serial.print("Distancia: ");
    Serial.print(distancia);
    Serial.println(" cm");

    Serial.print("Nivel: ");
    Serial.print(nivel);
    Serial.println("%");

    if (nivel >= 80) {

      status = "CHEIA";
      Serial.println("[ALERTA] LIXEIRA CHEIA!");

      for (int i = 0; i < 3; i++) {
        digitalWrite(BUZZER_PIN, HIGH);
        delay(300);
        digitalWrite(BUZZER_PIN, LOW);
        delay(200);
      }

    } else if (nivel >= 50) {

      status = "QUASE_CHEIA";
      Serial.println("[ATENCAO] LIXEIRA QUASE CHEIA!");
      digitalWrite(BUZZER_PIN, LOW);

    } else {

      status = "NORMAL";
      Serial.println("[STATUS] LIXEIRA NORMAL!");
      digitalWrite(BUZZER_PIN, LOW);
    }

    enviarDados(distancia, nivel, status);
  }

  delay(1000);
}
