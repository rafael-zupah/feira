/**
 * Feira Cultural — servidor Node
 *
 * Este arquivo é a ponte. O app em si está em src/worker.js, escrito na API
 * padrão de Request/Response; aqui a gente converte o req/res do Node para
 * aquela API, chama o app e devolve a resposta. É isso que permite o mesmo
 * código rodar no VPS (por este arquivo) e num Worker da Cloudflare.
 *
 * Quem roda isto em produção é o PM2 (veja ecosystem.config.cjs), atrás do
 * Nginx. O Nginx serve os arquivos de public/ sozinho e manda só /api/ para cá.
 * Mesmo assim este arquivo também sabe servir o public/, para que
 * `node server.js` funcione sozinho durante um teste — sem Nginx no meio.
 *
 * Não tem nenhuma dependência: só a biblioteca padrão do Node.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import aplicacao from "./src/worker.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_PUBLICA = join(AQUI, "public");

/**
 * Carrega o .env feito à mão, em vez de usar `node --env-file`.
 *
 * O --env-file só existe a partir do Node 20.6, e a versão do Node no VPS não é
 * conhecida. Além disso ele aborta o processo com uma mensagem críptica quando
 * o arquivo não existe; aqui a ausência do .env é tratada como "use as
 * variáveis de ambiente do sistema", que é o comportamento esperado no PM2.
 *
 * O trim() em cada linha também resolve o \r teimoso de arquivo editado no
 * Windows, que faria a chave virar "AIza...\r" e o Google responder 403.
 */
function carregarEnv(caminho) {
  let texto;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch (falha) {
    if (falha.code === "ENOENT") return {};
    throw falha;
  }

  const valores = {};
  for (const linha of texto.split("\n")) {
    const limpa = linha.replace(/^﻿/, "").trim();
    if (!limpa || limpa.startsWith("#")) continue;

    const igual = limpa.indexOf("=");
    if (igual === -1) continue;

    const chave = limpa.slice(0, igual).trim();
    let valor = limpa.slice(igual + 1).trim();
    const entreAspas =
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"));
    if (entreAspas && valor.length >= 2) valor = valor.slice(1, -1);

    valores[chave] = valor;
  }
  return valores;
}

// Variável de ambiente de verdade ganha do arquivo: é o que permite sobrescrever
// um valor pelo PM2 ou por um teste pontual sem editar o .env.
const env = { ...carregarEnv(join(AQUI, ".env")), ...process.env };

const PORTA = Number(env.PORT) || 8090;
const HOST = env.HOST || "127.0.0.1";

/**
 * Teto do corpo da requisição. Fica acima do client_max_body_size do Nginx (4m)
 * de propósito: assim quem recusa um upload grande é o Nginx, com uma página de
 * erro decente, e não um socket derrubado no meio.
 */
const LIMITE_CORPO = 6 * 1024 * 1024;

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/**
 * Cabeçalhos que não devem ser repassados para o Request.
 *
 * `host` e `content-length` porque o valor do cliente deixaria de valer; os de
 * conexão porque quem cuida disso é o Node, não o app.
 */
const CABECALHOS_FORA = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "content-length",
]);

class CorpoGrandeDemais extends Error {}

// ---------------------------------------------------------------------------
// Ponte Node → Request/Response padrão
// ---------------------------------------------------------------------------

/**
 * Lê o corpo inteiro antes de seguir.
 *
 * O app é pequeno e o corpo é, no máximo, uma foto reduzida — bufferizar é mais
 * simples e mais seguro do que repassar o stream, que exigiria `duplex: "half"`
 * e traria à tona casos de borda de backpressure e cancelamento.
 */
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    const partes = [];
    let total = 0;

    req.on("data", (parte) => {
      total += parte.length;
      if (total > LIMITE_CORPO) {
        req.destroy();
        falha(new CorpoGrandeDemais());
        return;
      }
      partes.push(parte);
    });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", falha);
  });
}

function paraRequestWeb(req, corpo, sinal) {
  const cabecalhos = new Headers();
  for (const [chave, valor] of Object.entries(req.headers)) {
    if (CABECALHOS_FORA.has(chave)) continue;
    if (Array.isArray(valor)) valor.forEach((v) => cabecalhos.append(chave, v));
    else if (valor != null) cabecalhos.set(chave, valor);
  }

  // O IP que vale é o do socket ou o que o Nginx escreveu. O que o visitante
  // mandou é descartado, senão ele mesmo escolheria o próprio limite de uso.
  cabecalhos.delete("cf-connecting-ip");
  if (!cabecalhos.has("x-real-ip") && req.socket.remoteAddress) {
    cabecalhos.set("x-real-ip", req.socket.remoteAddress);
  }

  return new Request(`http://${HOST}:${PORTA}${req.url}`, {
    method: req.method,
    headers: cabecalhos,
    body: corpo.length ? corpo : undefined,
    signal: sinal,
  });
}

async function enviarResposta(res, resposta) {
  const cabecalhos = {};
  for (const [chave, valor] of resposta.headers) {
    // content-length e transfer-encoding saem fora: quem monta a resposta HTTP
    // final é o Node, e um comprimento herdado do Response daria divergência.
    if (chave === "content-length" || chave === "transfer-encoding") continue;
    cabecalhos[chave] = valor;
  }

  res.writeHead(resposta.status, cabecalhos);
  if (!resposta.body) {
    res.end();
    return;
  }
  Readable.fromWeb(resposta.body).pipe(res);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

async function tratarApi(req, res) {
  // Se o visitante fechar a aba no meio da geração, isto avisa o app, que
  // cancela a chamada ao Google. Sem isso a imagem seria gerada e cobrada à toa.
  const controle = new AbortController();
  res.on("close", () => controle.abort());

  try {
    const corpo = await lerCorpo(req);
    const pedido = paraRequestWeb(req, corpo, controle.signal);
    const resposta = await aplicacao.fetch(pedido, env);
    await enviarResposta(res, resposta);
  } catch (falha) {
    if (falha instanceof CorpoGrandeDemais) {
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ erro: "O envio ficou grande demais. Tente outra foto." }));
      return;
    }

    console.error(`Falha ao atender ${req.url}:`, falha);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ erro: "Deu um problema inesperado. Tente de novo." }));
  }
}

function naoEncontrado(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Não encontrado.");
}

function servirEstatico(req, res, pathname) {
  let caminho;
  try {
    caminho = decodeURIComponent(pathname);
  } catch {
    return naoEncontrado(res);
  }
  if (caminho === "/") caminho = "/index.html";

  // resolve() com "." + caminho normaliza os ".." e o resultado tem de continuar
  // dentro de public/. Sem esta checagem, /../.env serviria a chave do Gemini.
  const alvo = resolve(RAIZ_PUBLICA, `.${caminho}`);
  if (alvo !== RAIZ_PUBLICA && !alvo.startsWith(RAIZ_PUBLICA + sep)) {
    return naoEncontrado(res);
  }

  let informacao;
  try {
    informacao = statSync(alvo);
  } catch {
    return naoEncontrado(res);
  }
  if (informacao.isDirectory()) return naoEncontrado(res);

  res.writeHead(200, {
    "content-type": TIPOS[extname(alvo).toLowerCase()] ?? "application/octet-stream",
    "content-length": informacao.size,
    // Sem cache: se for preciso corrigir a página no meio do evento, o celular
    // do visitante pega a versão nova no primeiro recarregar.
    "cache-control": "no-cache",
  });
  createReadStream(alvo).pipe(res);
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

const servidor = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORTA}`);

  if (pathname.startsWith("/api/")) {
    tratarApi(req, res);
    return;
  }
  servirEstatico(req, res, pathname);
});

servidor.listen(PORTA, HOST, () => {
  console.log(`Feira no ar em http://${HOST}:${PORTA}`);
  console.log(`Modelo de imagem: gemini-3.1-flash-image (US$ 0,067 por imagem)`);

  if (!env.GEMINI_API_KEY) {
    console.error(
      "ATENÇÃO: GEMINI_API_KEY não está definida. Toda geração vai falhar.\n" +
        `Crie o arquivo ${join(AQUI, ".env")} a partir do .env.example.`,
    );
  }
});

// O PM2 manda SIGINT no restart; sem isto o processo fica pendurado até o kill.
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    servidor.close(() => process.exit(0));
  });
}
