// Copie este arquivo para "secrets.h" (na mesma pasta) e preencha.
// O secrets.h NÃO vai para o GitHub (está no .gitignore).
#pragma once

#define WIFI_SSID     "NOME_DO_WIFI"
#define WIFI_PASSWORD "SENHA_DO_WIFI"

// IP do computador onde o Docker (HiveMQ) está rodando.
// No Windows, descubra com o comando: ipconfig  (campo "Endereço IPv4")
#define MQTT_HOST     "192.168.18.5"
#define MQTT_PORT     1883

// Deixe vazio ("") se o HiveMQ local não usa usuário/senha
#define MQTT_USER     ""
#define MQTT_PASSWORD ""
