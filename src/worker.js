/**
 * Feira Cultural — Gerador de Personagens
 *
 * Este arquivo é o app inteiro. Ele é escrito na API padrão de Request/Response
 * (a mesma que existe no navegador), então roda nos dois lugares sem mudança:
 *
 *   - no VPS, através do server.js (Node + PM2 + Nginx) — o caminho normal
 *   - num Worker da Cloudflare, se um dia precisar de um plano B às pressas
 *
 * Rotas:
 *   GET  /api/health    teste barato, não gasta cota
 *   POST /api/generate  recebe a foto e devolve o personagem
 *   GET|POST /api/probe sonda de diagnóstico (ver README, passo "sonda")
 *
 * O caminho da geração é UMA chamada só:
 *
 *   foto + estilo ──▶ gemini-3.1-flash-image ──▶ imagem do personagem
 *
 * O modelo lê a foto e desenha, então a semelhança vem dele mesmo — não de um
 * texto intermediário. A foto nunca é gravada em disco, banco ou log: ela vive
 * só na memória enquanto esta requisição está sendo atendida.
 */

/**
 * Modelo de imagem. Ele aceita a foto como referência e preserva o rosto.
 *
 * Custo: US$ 0,067 por imagem em 1K. Não existe cota gratuita — a geração de
 * imagem saiu do tier grátis do Google em dezembro de 2025. Veja o README.
 */
const MODELO_IMAGEM = "gemini-3.1-flash-image";

/** A foto já chega reduzida pelo navegador; isto é só um teto de segurança. */
const MAX_FOTO_BYTES = 3 * 1024 * 1024;

/** Limite por pessoa, para uma sozinha não queimar o orçamento do dia. */
const LIMITE_POR_JANELA = 5;
const JANELA_MS = 10 * 60 * 1000;

/**
 * Quantas gerações podem estar em andamento ao mesmo tempo.
 *
 * O Google atende ~10 imagens por minuto no Tier 1. Numa fila de estande isso
 * estoura fácil: quinze pessoas escaneando o QR ao mesmo tempo receberiam erro
 * em vez de "espere um pouco". Enfileirar aqui dentro é a diferença entre as
 * duas coisas. Não é teto de gasto — é controle de vazão.
 */
const MAX_SIMULTANEAS = 3;

/**
 * Teto de tempo da chamada ao Google.
 *
 * 50s e não 60s de propósito: o Safari corta qualquer requisição em 60 segundos
 * e o iPhone veria um "Load failed" em inglês, sem explicação. Melhor devolver
 * um erro nosso, em português, um pouco antes.
 */
const TEMPO_LIMITE_MS = 50_000;

/**
 * Os seis estilos oferecidos.
 * `direcao` é o trecho em inglês que diz ao modelo *como* desenhar a pessoa.
 */
const ESTILOS = {
  personagem: {
    direcao:
      "a stylized character design illustration with clean confident shapes, " +
      "a strong silhouette and rich colour",
  },
  desenho: {
    direcao:
      "a hand-drawn illustration with visible pencil-and-ink line work and " +
      "soft watercolour shading",
  },
  "foto-realista": {
    direcao:
      "a realistic professional studio photograph with natural skin texture, " +
      "a soft key light and shallow depth of field",
  },
  videogame: {
    direcao:
      "a 3D videogame character render with stylised heroic proportions, " +
      "rim lighting and a detailed game-ready look",
  },
  filme: {
    direcao:
      "a cinematic movie still with dramatic lighting, film colour grading " +
      "and an anamorphic look",
  },
  "desenho-animado": {
    direcao:
      "a cartoon illustration with bold black outlines, flat vibrant colours " +
      "and warm exaggerated features",
  },
};

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Barato e sem cota: serve para saber se o processo está de pé antes de
    // gastar dinheiro com uma geração de verdade.
    if (pathname === "/api/health") {
      return json({ ok: true, modelo: MODELO_IMAGEM });
    }

    if (pathname === "/api/generate") {
      if (request.method !== "POST") return erro("Esta rota só aceita POST.", 405);
      return gerar(request, env);
    }

    if (pathname === "/api/probe") {
      return sonda(request, env);
    }

    return erro("Rota não encontrada.", 404);
  },
};

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

async function gerar(request, env) {
  try {
    if (!env.GEMINI_API_KEY) {
      return erro(
        "Falta configurar a chave do Gemini (GEMINI_API_KEY) no .env do servidor.",
        500,
      );
    }

    // --- validação ---
    let dados;
    try {
      dados = await request.json();
    } catch {
      return erro("Não consegui ler os dados enviados.");
    }

    const nome = String(dados?.nome ?? "").trim().slice(0, 60);
    const profissao = String(dados?.profissao ?? "").trim().slice(0, 60);
    // Object.hasOwn e não ESTILOS[...] direto: um valor como "constructor" ou
    // "__proto__" traria uma propriedade herdada e passaria pela validação.
    const chaveEstilo = String(dados?.estilo ?? "");
    const estilo = Object.hasOwn(ESTILOS, chaveEstilo) ? ESTILOS[chaveEstilo] : null;
    const foto = String(dados?.foto ?? "");

    if (!nome) return erro("Falta o seu nome.");
    if (!profissao) return erro("Falta a sua profissão.");
    if (!estilo) return erro("Escolha um estilo.");

    const partes = foto.match(/^data:([^;]+);base64,(.+)$/s);
    if (!partes) return erro("A foto não chegou no formato esperado.");
    const [, mime, b64] = partes;

    if (!mime.startsWith("image/")) return erro("O arquivo enviado não é uma imagem.");

    // Confere o tamanho ANTES de decodificar: não faz sentido montar um
    // Uint8Array de vários megabytes só para recusá-lo na linha seguinte.
    if (b64.length * 0.75 > MAX_FOTO_BYTES) {
      return erro("A foto ficou grande demais. Tente outra.");
    }

    // O limite só conta o que passou da validação: um pedido malformado não
    // deve gastar a cota de quem está tentando de verdade.
    const ip = ipDoPedido(request);
    if (excedeuLimite(ip)) {
      return erro(
        "Você já gerou vários personagens agora há pouco. Espere alguns minutos.",
        429,
      );
    }

    await adquirirVaga();
    let saida;
    try {
      saida = await desenhar(env, {
        nome,
        profissao,
        estilo,
        b64,
        mime,
        sinal: request.signal,
      });
    } finally {
      liberarVaga();
    }

    return json({
      imagem: `data:${saida.mime};base64,${saida.dados}`,
      modelo: MODELO_IMAGEM,
    });
  } catch (falha) {
    if (falha instanceof ErroAmigavel) return erro(falha.message, falha.status);
    console.error("Erro inesperado em /api/generate:", falha);
    return erro("Deu um problema inesperado. Tente de novo.", 500);
  }
}

/**
 * Monta a instrução em inglês para o modelo de imagem.
 *
 * A ordem importa: primeiro a ordem de preservar a semelhança, que é o que faz
 * o visitante se reconhecer, e só depois o estilo.
 */
function montarPrompt({ nome, profissao, estilo }) {
  return [
    "You are the illustrator at a character portrait booth at a Brazilian",
    "school cultural fair. Look at the photo and draw THIS person.",
    "",
    "The most important thing: the character must be recognisable as the person",
    "in the photo. Keep their real apparent age, skin tone, hair colour, length",
    "and style, facial hair, glasses, distinctive features and the clothing they",
    "are wearing. Do not make them look like a different person.",
    "",
    `Render them as ${estilo.direcao}.`,
    "",
    `Context: their name is ${nome} and they work as ${profissao}. You may place`,
    "them in a setting or with props that suit that profession, if it fits",
    "naturally.",
    "",
    "Keep the composition a single centred character portrait, chest-up, against",
    "a simple background. Do not add any text or watermark.",
  ].join("\n");
}

/**
 * Chama o modelo de imagem e devolve os bytes do personagem.
 *
 * O corpo enviado é o mínimo que funciona. Em especial NÃO mandamos:
 *
 *   - `imageConfig`: a documentação do Google está em transição e há relatos de
 *     `imageSize` ser ignorado. Aceitar o padrão (1K) evita a briga inteira.
 *   - `temperature`: não significa nada para saída de imagem.
 *   - `thinkingConfig`: o raciocínio não é totalmente desligável nos modelos 3.x
 *     de imagem, e um orçamento de 0 chega a devolver erro 400.
 *   - `maxOutputTokens` baixo: uma imagem 1K consome ~1.120 tokens. O valor 512,
 *     que servia para a etapa de texto, faria toda geração voltar cortada e sem
 *     imagem nenhuma.
 */
async function desenhar(env, { nome, profissao, estilo, b64, mime, sinal }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IMAGEM}:generateContent`;

  const corpo = {
    contents: [
      {
        role: "user",
        parts: [
          { text: montarPrompt({ nome, profissao, estilo }) },
          { inline_data: { mime_type: mime, data: b64 } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      maxOutputTokens: 8192,
    },
  };

  const { signal, limpar } = sinalComLimite(sinal, TEMPO_LIMITE_MS);

  let resposta;
  try {
    resposta = await comRetentativa(() =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Chave no cabeçalho (e não na URL) para não vazar em log de acesso.
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify(corpo),
        signal,
      }),
    );
  } catch (falha) {
    console.error("Gemini inacessível:", falha?.message ?? falha);
    if (falha?.name === "AbortError" || falha?.name === "TimeoutError") {
      throw new ErroAmigavel(
        "A geração demorou demais e foi cancelada. Tente de novo.",
        504,
      );
    }
    throw new ErroAmigavel("Não consegui falar com o serviço de imagem. Tente de novo.", 502);
  } finally {
    limpar();
  }

  if (!resposta.ok) {
    const detalhe = await resposta.text();
    console.error("Gemini falhou:", resposta.status, detalhe.slice(0, 800));

    if (resposta.status === 429) {
      throw new ErroAmigavel(
        "Muita gente gerando ao mesmo tempo. Espere um minutinho e tente de novo.",
        429,
      );
    }
    if (resposta.status === 401 || resposta.status === 403) {
      throw new ErroAmigavel(
        "A chave do Gemini parece inválida, ou a conta está sem cobrança ativa. " +
          "Confira o GEMINI_API_KEY e o billing do projeto no Google.",
        500,
      );
    }
    if (resposta.status === 404) {
      throw new ErroAmigavel(
        `O modelo "${MODELO_IMAGEM}" não foi encontrado. Atualize MODELO_IMAGEM no worker.`,
        500,
      );
    }
    throw new ErroAmigavel("Não consegui desenhar o seu personagem agora. Tente de novo.", 502);
  }

  const retorno = await resposta.json();
  const candidato = retorno?.candidates?.[0];

  // Bloqueio antes mesmo de gerar: o pedido foi recusado.
  if (retorno?.promptFeedback?.blockReason && !candidato) {
    console.error("Gemini bloqueou o prompt:", retorno.promptFeedback.blockReason);
    throw new ErroAmigavel(
      "Não consegui trabalhar com essa foto. Tente outra, de frente e bem iluminada.",
      422,
    );
  }

  // As imagens de raciocínio chegam como inlineData marcado com thought: true.
  // Sem filtrar, dá para entregar ao visitante um rascunho de baixa resolução.
  const imagens = (candidato?.content?.parts ?? []).filter(
    (parte) =>
      parte.thought !== true &&
      parte.inlineData?.data &&
      String(parte.inlineData.mimeType ?? "").startsWith("image/"),
  );

  // Se o modelo devolver mais de uma imagem, a última é a boa: quando ele manda
  // um rascunho e a versão final, a final vem depois.
  const imagem = imagens.at(-1);
  if (imagem) {
    return { dados: imagem.inlineData.data, mime: imagem.inlineData.mimeType };
  }

  // Sem imagem: o modelo ou recusou, ou estourou o teto de tokens. As duas
  // coisas ficam no log, porque a mensagem ao visitante é a mesma.
  const texto = (candidato?.content?.parts ?? [])
    .filter((parte) => parte.thought !== true)
    .map((parte) => parte.text ?? "")
    .join(" ")
    .trim();
  const motivo = candidato?.finishReason;
  console.error(
    "Gemini devolveu sem imagem. finishReason:",
    motivo,
    "texto:",
    texto.slice(0, 300),
  );

  if (MOTIVOS_DE_RECUSA.includes(motivo)) {
    throw new ErroAmigavel(
      "Não consegui trabalhar com essa foto. Tente outra, de frente e bem iluminada.",
      422,
    );
  }
  throw new ErroAmigavel("O desenho não saiu. Tente de novo.", 502);
}

/** Motivos de término em que o modelo se recusou a desenhar. */
const MOTIVOS_DE_RECUSA = [
  "SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "SPII",
];

// ---------------------------------------------------------------------------
// Sonda de diagnóstico
// ---------------------------------------------------------------------------
// Serve para descobrir, antes de abrir o estande, três coisas que decidem o dia:
//   - a chamada ao modelo de imagem funciona mesmo com a chave de produção?
//   - quanto tempo uma geração leva de verdade, no servidor?
//   - se falhar, qual foi a resposta crua do Google?
//
// GET  /api/probe              → teste básico, sem foto
// POST /api/probe (multipart)  → teste com uma foto de verdade
//        campos: foto (arquivo), prompt (texto, opcional)

async function sonda(request, env) {
  if (!env.GEMINI_API_KEY) {
    return erro("Falta configurar a chave do Gemini (GEMINI_API_KEY) no .env do servidor.", 500);
  }

  let prompt =
    "a friendly cartoon robot mascot, bold outlines, flat vibrant colours, plain background";
  let foto = null;

  if (request.method === "POST") {
    try {
      const entrada = await request.formData();
      const arquivo = entrada.get("foto");
      if (arquivo && typeof arquivo === "object" && arquivo.size > 0) foto = arquivo;
      if (entrada.get("prompt")) prompt = String(entrada.get("prompt"));
    } catch (falha) {
      return erro(`Não consegui ler o formulário: ${falha?.message ?? falha}`);
    }
  }

  const inicio = Date.now();
  try {
    const partes = [{ text: prompt }];
    if (foto) {
      const bytes = new Uint8Array(await foto.arrayBuffer());
      partes.push({
        inline_data: {
          mime_type: foto.type || "image/jpeg",
          data: bytesParaBase64(bytes),
        },
      });
    }

    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IMAGEM}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: partes }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      },
    );

    const cru = await resposta.json();
    const candidato = cru?.candidates?.[0];
    const imagens = (candidato?.content?.parts ?? []).filter(
      (parte) => parte.thought !== true && parte.inlineData?.data,
    );
    const imagem = imagens.at(-1);

    // Aqui devolvemos o suficiente para diagnosticar: se não veio imagem, o
    // motivo e a resposta crua do Google aparecem na tela.
    return json({
      ok: Boolean(imagem),
      modelo: MODELO_IMAGEM,
      statusHttp: resposta.status,
      comFoto: Boolean(foto),
      fotoBytes: foto?.size ?? 0,
      ms: Date.now() - inicio,
      finishReason: candidato?.finishReason ?? null,
      texto:
        (candidato?.content?.parts ?? [])
          .filter((parte) => parte.thought !== true)
          .map((parte) => parte.text ?? "")
          .join(" ")
          .trim() || null,
      bytesGerados: imagem ? Math.round(imagem.inlineData.data.length * 0.75) : 0,
      imagem: imagem
        ? `data:${imagem.inlineData.mimeType};base64,${imagem.inlineData.data}`
        : null,
      respostaCrua: imagem ? null : cru,
    });
  } catch (falha) {
    // O erro cru de propósito: é exatamente a informação que queremos ler.
    return json(
      {
        ok: false,
        modelo: MODELO_IMAGEM,
        comFoto: Boolean(foto),
        fotoBytes: foto?.size ?? 0,
        ms: Date.now() - inicio,
        erro: String(falha?.message ?? falha),
      },
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** Erro cuja mensagem pode ser mostrada direto para o visitante. */
class ErroAmigavel extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

function json(corpo, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function erro(mensagem, status = 400) {
  return json({ erro: mensagem }, status);
}

/**
 * De quem é este pedido.
 *
 * A ordem importa e é uma questão de segurança, não de gosto. Atrás do Nginx,
 * `CF-Connecting-IP` é um cabeçalho como qualquer outro: se fosse o primeiro da
 * lista, qualquer visitante mandaria `CF-Connecting-IP: <aleatório>` a cada
 * pedido e teria gerações ilimitadas numa API paga. Por isso `X-Real-IP` vem
 * primeiro — o Nginx o sobrescreve com o IP real da conexão — e o server.js o
 * preenche a partir do socket quando ninguém preencheu.
 */
function ipDoPedido(request) {
  return (
    request.headers.get("x-real-ip") ?? request.headers.get("cf-connecting-ip") ?? "desconhecido"
  );
}

/**
 * Uma tentativa extra quando o Google responde "estou ocupado".
 *
 * 429 e 503 são passageiros e comuns num pico de fila; repetir uma vez com uma
 * espera aleatória resolve a maioria sem o visitante ver erro nenhum.
 */
async function comRetentativa(acao, tentativas = 2) {
  for (let tentativa = 1; ; tentativa += 1) {
    const resposta = await acao();
    const ocupado = resposta.status === 429 || resposta.status === 503;
    if (!ocupado || tentativa >= tentativas) return resposta;

    console.warn(`Gemini respondeu ${resposta.status}; repetindo (${tentativa}).`);
    // Descarta o corpo antes de repetir, senão a conexão fica pendurada.
    try {
      await resposta.body?.cancel();
    } catch {
      // Já consumido ou inexistente: não importa.
    }
    await new Promise((ok) => setTimeout(ok, 1500 + Math.random() * 1500));
  }
}

/**
 * Junta o sinal de quem pediu (o visitante pode fechar a aba) com um teto de
 * tempo nosso. Sem isto, um pedido abandonado continuaria sendo cobrado.
 *
 * Feito à mão em vez de AbortSignal.any porque aquele só existe a partir do
 * Node 20.3, e a versão do Node no VPS não é conhecida.
 */
function sinalComLimite(sinalExterno, ms) {
  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), ms);
  const cancelar = () => controle.abort();

  if (sinalExterno) {
    if (sinalExterno.aborted) cancelar();
    else sinalExterno.addEventListener("abort", cancelar, { once: true });
  }

  return {
    signal: controle.signal,
    limpar() {
      clearTimeout(alarme);
      sinalExterno?.removeEventListener("abort", cancelar);
    },
  };
}

/**
 * Fila de espera: no máximo MAX_SIMULTANEAS gerações ao mesmo tempo.
 * Quem chega depois espera a vez em vez de receber erro.
 */
let emUso = 0;
const fila = [];

function adquirirVaga() {
  if (emUso < MAX_SIMULTANEAS) {
    emUso += 1;
    return Promise.resolve();
  }
  return new Promise((ok) => fila.push(ok));
}

function liberarVaga() {
  const proximo = fila.shift();
  // Antes de passar a vez não devolvemos a vaga: ela já é de quem entrou.
  if (proximo) proximo();
  else emUso -= 1;
}

function bytesParaBase64(bytes) {
  let binario = "";
  for (let i = 0; i < bytes.length; i += 1) binario += String.fromCharCode(bytes[i]);
  return btoa(binario);
}

/**
 * Limite por IP guardado em memória. Cada processo tem o seu próprio mapa, e é
 * por isso que o PM2 roda uma instância só (veja ecosystem.config.cjs). É uma
 * trava grossa — impede que uma pessoa sozinha queime o orçamento, não é
 * proteção séria contra abuso.
 */
const usos = new Map();

function excedeuLimite(ip) {
  const agora = Date.now();
  const recentes = (usos.get(ip) ?? []).filter((t) => agora - t < JANELA_MS);

  if (recentes.length >= LIMITE_POR_JANELA) return true;

  recentes.push(agora);
  usos.set(ip, recentes);

  // Limpeza preguiçosa, para o mapa não crescer sem limite.
  if (usos.size > 500) {
    for (const [chave, marcas] of usos) {
      if (marcas.every((t) => agora - t >= JANELA_MS)) usos.delete(chave);
    }
  }

  return false;
}
