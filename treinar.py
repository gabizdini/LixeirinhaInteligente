"""
Treina o modelo de previsão e gera previsao.json para o dashboard.
Rodar manualmente: python treinar.py   (o coletor também chama automaticamente)
"""
import json
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

CSV = "dados_lixeira.csv"
SAIDA = "previsao.json"
LIMITE_METADE = 50
LIMITE_CHEIA = 80
PASSO_MIN = 2         # resolução da simulação e da reamostragem
QUEDA_ESVAZIOU = 20     # queda (pontos %) que indica que o lixo foi retirado
MIN_AMOSTRAS = 3        # mínimo de intervalos com enchimento para prever
AMOSTRAS_CONFIAVEL = 100


def carregar():
    df = pd.read_csv(CSV)
    df["data_hora"] = pd.to_datetime(df["data_hora"], errors="coerce")
    df["ocupacao"] = pd.to_numeric(df["ocupacao"], errors="coerce")
    df = df.dropna(subset=["data_hora", "ocupacao"]).sort_values("data_hora")
    return df[["data_hora", "ocupacao"]]


def montar_amostras(df):
    """Taxa de enchimento (%/h) entre leituras consecutivas, dentro do mesmo ciclo."""
    s = (df.set_index("data_hora")["ocupacao"]
           .resample(f"{PASSO_MIN}min").median().dropna())
    if len(s) < 2:
        return pd.DataFrame(columns=["hora", "dia", "taxa"]), 0

    ciclo = (s.diff() < -QUEDA_ESVAZIOU).cumsum()
    dt_h = s.index.to_series().diff().dt.total_seconds() / 3600
    taxa = s.diff() / dt_h

    ok = (ciclo == ciclo.shift()) & (dt_h <= 2)      # mesmo ciclo e sem buracos grandes
    am = pd.DataFrame({
        "hora": s.index.hour + s.index.minute / 60,
        "dia": s.index.dayofweek,
        "taxa": taxa.clip(lower=0),                  # ruído do sensor não "esvazia"
    })[ok]
    return am.dropna(), int(ciclo.nunique())


def salvar(dados):
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def treinar():
    agora = datetime.now().isoformat(timespec="seconds")
    try:
        df = carregar()
    except FileNotFoundError:
        salvar({"pronto": False, "gerado_em": agora, "motivo": "Ainda sem dados coletados"})
        return

    amostras, ciclos = montar_amostras(df)
    if df.empty or len(amostras) < MIN_AMOSTRAS:
        salvar({"pronto": False, "gerado_em": agora, "amostras": len(amostras),
                "motivo": f"Coletando dados ({len(amostras)}/{MIN_AMOSTRAS} intervalos)"})
        return

    taxa_media = float(amostras["taxa"].mean())
    modelo = None
    if len(amostras) >= 40:
        modelo = RandomForestRegressor(n_estimators=200, min_samples_leaf=3, random_state=0)
        modelo.fit(amostras[["hora", "dia"]].values, amostras["taxa"].values)

    def taxa_em(t):
        if modelo is None:
            return taxa_media
        x = np.array([[t.hour + t.minute / 60, t.weekday()]])
        return float(max(modelo.predict(x)[0], 0))

    ultima = df.iloc[-1]
    ocup = float(ultima["ocupacao"])
    inicio = ultima["data_hora"].to_pydatetime()

    marcos = {LIMITE_METADE: None, LIMITE_CHEIA: None}
    for lim in marcos:
        if ocup >= lim:
            marcos[lim] = inicio

    t, o = inicio, ocup
    for _ in range(int(7 * 24 * 60 / PASSO_MIN)):    # simula até 7 dias
        o += taxa_em(t) * PASSO_MIN / 60
        t += timedelta(minutes=PASSO_MIN)
        for lim in marcos:
            if marcos[lim] is None and o >= lim:
                marcos[lim] = t
        if all(marcos.values()):
            break

    fmt = lambda x: x.isoformat(timespec="minutes") if x else None
    salvar({
        "pronto": True,
        "gerado_em": agora,
        "ultima_leitura": fmt(inicio),
        "ocupacao_atual": round(ocup, 1),
        "horario_metade": fmt(marcos[LIMITE_METADE]),
        "horario_cheia": fmt(marcos[LIMITE_CHEIA]),
        "taxa_media_por_hora": round(taxa_media, 2),
        "amostras": len(amostras),
        "ciclos": ciclos,
        "modelo": "RandomForest (hora + dia da semana)" if modelo else "Taxa média",
        "confianca": "boa" if len(amostras) >= AMOSTRAS_CONFIAVEL else "baixa (poucos dados)",
    })


if __name__ == "__main__":
    treinar()
    print(open(SAIDA, encoding="utf-8").read())