                                                                                                                /**
 * Feira Cultural — Gerador de Personagens
 *
 * O Worker faz duas coisas:
 *   1. POST /api/generate  — recebe a foto e devolve o personagem estilizado.
 *   2. GET|POST /api/probe — sonda de diagnóstico (ver README, passo "sonda").
 *
 * O caminho da geração tem duas etapas, cada uma numa IA gratuita diferente:
 *
 *   foto ──▶ Gemini Flash (visão, grátis)     ──▶ prompt detalhado em inglês
 *        ──▶ FLUX.2 klein no Workers AI (grátis) ──▶ imagem do personagem
 *
 * A foto nunca é gravada em disco, KV, R2 ou log: ela vive só na memória
 * enquanto esta requisição está sendo atendida.
 */

/** Modelo de visão do Gemini que lê a foto. Se der 404, atualize aqui. */
const GEMINI_MODEL = "gemini-2.5-flash";

/** Modelo de imagem. Aceita a foto como referência (image-to-image). */
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

/**
 * Tamanho da imagem gerada.
 * ATENÇÃO: o custo em neurons cresce com a área. 1024x1024 gasta ~4x mais que
 * 512x512. A cota gratuita é de 10.000 neurons/dia — veja a sonda para medir.
 */
const LARGURA = 1024;
const ALTURA = 1024;

/** A foto já chega reduzida pelo navegador; isto é só um teto de segurança. */
const MAX_FOTO_BYTES = 3 * 1024 * 1024;

/** Limite por pessoa, para uma sozinha não queimar a cota do dia. */
const LIMITE_POR_JANELA = 5;
const JANELA_MS = 10 * 60 * 1000;

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
        "Falta configurar a chave do Gemini. Rode: npx wrangler secret put GEMINI_API_KEY",
        500,
      );
    }
    if (!env.AI) {
      return erro("O binding de IA não está configurado no wrangler.jsonc.", 500);
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

    const bytesFoto = base64ParaBytes(b64);
    if (bytesFoto.byteLength > MAX_FOTO_BYTES) {
      return erro("A foto ficou grande demais. Tente outra.");
    }

    // O limite só conta o que passou da validação: um pedido malformado não
    // deve gastar a cota de quem está tentando de verdade.
    const ip = request.headers.get("CF-Connecting-IP") ?? "desconhecido";
    if (excedeuLimite(ip)) {
      return erro(
        "Você já gerou vários personagens agora há pouco. Espere alguns minutos.",
        429,
      );
    }

    // --- etapa 1: o Gemini olha a foto e escreve o prompt ---
    const prompt = await descreverPessoa(env, { nome, profissao, estilo, b64, mime });

    // --- etapa 2: o FLUX desenha ---
    const imagem = await desenhar(env, prompt, bytesFoto, mime);

    return json({
      imagem: `data:image/png;base64,${imagem}`,
      prompt, // devolvido para você poder inspecionar o que o Gemini escreveu
    });
  } catch (falha) {
    if (falha instanceof ErroAmigavel) return erro(falha.message, falha.status);
    console.error("Erro inesperado em /api/generate:", falha);
    return erro("Deu um problema inesperado. Tente de novo.", 500);
  }
}

/**
 * Pede ao Gemini um prompt de geração de imagem em inglês, descrevendo a
 * aparência real da pessoa. É este texto que carrega a semelhança: a foto
 * enviada ao FLUX é pequena, então os detalhes finos vêm daqui.
 */
async function descreverPessoa(env, { nome, profissao, estilo, b64, mime }) {
  const instrucao = [
    "You write image-generation prompts for a character portrait booth at a",
    "Brazilian school cultural fair. Look at the photo and write ONE English",
    "prompt (maximum 90 words) for an image model.",
    "",
    "Describe the person factually and respectfully, in this order: apparent age",
    "range, skin tone, hair colour / length / style, facial hair, glasses or other",
    "eyewear, distinctive features, and the clothing they are wearing.",
    `Then render the person as ${estilo.direcao}.`,
    "",
    `Context: their name is ${nome} and they work as ${profissao}. You may place`,
    "them in a setting or with props that suit that profession, if it fits naturally.",
    "",
    "Keep the composition a single centred character portrait, chest-up, against a",
    "simple background. Do not add any text or watermark.",
    "",
    "Output ONLY the prompt itself — no preamble, no quotes, no markdown.",
  ].join("\n");

  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Chave no cabeçalho (e não na URL) para não vazar em log de acesso.
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: instrucao },
              { inline_data: { mime_type: mime, data: b64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 1.0,
          maxOutputTokens: 512,
          // Desliga o "raciocínio" do modelo. Aqui só queremos que ele olhe a
          // foto e escreva o prompt: sem isto os tokens podem ser gastos
          // pensando, a resposta volta vazia e ainda demora bem mais.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );

  if (!resposta.ok) {
    const detalhe = await resposta.text();
    console.error("Gemini falhou:", resposta.status, detalhe.slice(0, 500));

    if (resposta.status === 429) {
      throw new ErroAmigavel(
        "Muita gente usando ao mesmo tempo. Espere um minutinho e tente de novo.",
        429,
      );
    }
    if (resposta.status === 401 || resposta.status === 403) {
      throw new ErroAmigavel(
        "A chave do Gemini parece inválida. Confira o secret GEMINI_API_KEY.",
        500,
      );
    }
    if (resposta.status === 404) {
      throw new ErroAmigavel(
        `O modelo "${GEMINI_MODEL}" não foi encontrado. Atualize a constante GEMINI_MODEL no worker.`,
        500,
      );
    }
    throw new ErroAmigavel("Não consegui analisar a sua foto agora. Tente de novo.", 502);
  }

  const corpo = await resposta.json();
  const texto = (corpo?.candidates?.[0]?.content?.parts ?? [])
    // Descarta as partes de raciocínio: só o texto final nos interessa.
    .filter((parte) => !parte.thought)
    .map((parte) => parte.text ?? "")
    .join("")
    .trim();

  if (!texto) {
    const motivo = corpo?.candidates?.[0]?.finishReason;
    console.error("Gemini devolveu vazio. finishReason:", motivo);
    if (motivo === "SAFETY" || motivo === "PROHIBITED_CONTENT") {
      throw new ErroAmigavel(
        "Não consegui trabalhar com essa foto. Tente outra, de frente e bem iluminada.",
        422,
      );
    }
    throw new ErroAmigavel("Não consegui analisar a sua foto. Tente outra.", 502);
  }

  return texto;
}

/**
 * Chama o FLUX.2 klein.
 *
 * Pegadinha: este modelo exige multipart form data *mesmo quando só há prompt*.
 * Por isso montamos um FormData e o serializamos num Response, de onde tiramos
 * o body e o boundary que o binding espera.
 */
async function desenhar(env, prompt, bytesFoto, mime) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(LARGURA));
  form.append("height", String(ALTURA));
  form.append("input_image_0", new Blob([bytesFoto], { type: mime }), "foto.jpg");

  let saida;
  try {
    const serializado = new Response(form);
    saida = await env.AI.run(IMAGE_MODEL, {
      multipart: {
        body: serializado.body,
        contentType: serializado.headers.get("content-type"),
      },
    });
  } catch (falha) {
    const mensagem = String(falha?.message ?? falha);
    console.error("Workers AI falhou:", mensagem);

    // A Cloudflare corta a requisição quando os 10.000 neurons do dia acabam.
    if (/neuron|quota|allocation|daily/i.test(mensagem)) {
      throw new ErroAmigavel(
        "A cota gratuita de imagens de hoje acabou. Ela renova às 21h, horário de Brasília.",
        429,
      );
    }
    throw new ErroAmigavel("Não consegui desenhar o seu personagem agora. Tente de novo.", 502);
  }

  if (!saida?.image) {
    console.error("Workers AI devolveu sem imagem:", JSON.stringify(saida).slice(0, 500));
    throw new ErroAmigavel("O desenho não saiu. Tente de novo.", 502);
  }

  return saida.image;
}

// ---------------------------------------------------------------------------
// Sonda de diagnóstico
// ---------------------------------------------------------------------------
// Serve para descobrir, antes de construir qualquer tela, três coisas que
// decidem o projeto:
//   - o formato multipart acima funciona de verdade dentro do Worker?
//   - qual é o limite real de tamanho da imagem de entrada do klein?
//   - quantos neurons uma geração consome na prática?
//
// GET  /api/probe                  → teste básico, só com prompt (sem foto)
// POST /api/probe  (multipart)     → teste com uma foto de verdade
//        campos: foto (arquivo), largura, altura  (opcionais)

async function sonda(request, env) {
  if (!env.AI) return erro("O binding de IA não está configurado no wrangler.jsonc.", 500);

  let prompt = "a friendly cartoon robot mascot, bold outlines, flat vibrant colours, plain background";
  let foto = null;
  let largura = LARGURA;
  let altura = ALTURA;

  if (request.method === "POST") {
    try {
      const entrada = await request.formData();
      const arquivo = entrada.get("foto");
      if (arquivo && typeof arquivo === "object" && arquivo.size > 0) foto = arquivo;
      if (entrada.get("prompt")) prompt = String(entrada.get("prompt"));
      if (entrada.get("largura")) largura = Number(entrada.get("largura")) || largura;
      if (entrada.get("altura")) altura = Number(entrada.get("altura")) || altura;
    } catch (falha) {
      return erro(`Não consegui ler o formulário: ${falha?.message ?? falha}`);
    }
  }

  const inicio = Date.now();
  try {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(largura));
    form.append("height", String(altura));
    if (foto) form.append("input_image_0", foto, foto.name || "foto.jpg");

    const serializado = new Response(form);
    const saida = await env.AI.run(IMAGE_MODEL, {
      multipart: {
        body: serializado.body,
        contentType: serializado.headers.get("content-type"),
      },
    });

    const b64 = saida?.image ?? "";

    return json({
      ok: true,
      modelo: IMAGE_MODEL,
      comFoto: Boolean(foto),
      fotoBytes: foto?.size ?? 0,
      tamanhoPedido: `${largura}x${altura}`,
      ms: Date.now() - inicio,
      bytesGerados: Math.round(b64.length * 0.75),
      imagem: b64 ? `data:image/png;base64,${b64}` : null,
    });
  } catch (falha) {
    // Aqui devolvemos o erro cru de propósito: é exatamente a informação que
    // queremos ler para descobrir o limite de tamanho da imagem de entrada.
    return json(
      {
        ok: false,
        modelo: IMAGE_MODEL,
        comFoto: Boolean(foto),
        fotoBytes: foto?.size ?? 0,
        tamanhoPedido: `${largura}x${altura}`,
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

function base64ParaBytes(b64) {
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/**
 * Limite por IP guardado em memória. Cada isolate tem o seu próprio mapa, então
 * isto é uma trava grossa — serve para impedir que uma pessoa sozinha queime a
 * cota do dia, não como proteção séria contra abuso.
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
