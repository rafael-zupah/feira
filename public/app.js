/**
 * Feira Cultural — Gerador de Personagens
 * Toda a lógica da página. Sem bibliotecas: só JS puro.
 */

// A foto é reduzida aqui no celular antes de subir. Isso deixa o envio rápido
// no 4G sem entregar ao modelo uma foto maior do que ele precisa.
//
// 1024 e não 512: o valor antigo era o limite do FLUX.2 klein. O modelo atual
// aceita bem mais, e é o detalhe do rosto que faz o visitante se reconhecer no
// personagem — reduzir demais era justamente o que estragava a semelhança.
const LADO_MAX = 1024;
const QUALIDADE_JPEG = 0.85;

const MENSAGENS_ESPERA = [
  "Lendo o seu rosto…",
  "Anotando o cabelo, os óculos, o jeitinho…",
  "Escolhendo as cores…",
  "Desenhando o seu personagem…",
  "Caprichando nos últimos detalhes…",
];

// --- elementos -------------------------------------------------------------
const telaForm = document.getElementById("tela-form");
const telaEspera = document.getElementById("tela-espera");
const telaResultado = document.getElementById("tela-resultado");
const telaErro = document.getElementById("tela-erro");

const campoNome = document.getElementById("nome");
const campoProfissao = document.getElementById("profissao");
const btnGerar = document.getElementById("btn-gerar");

const previa = document.getElementById("previa");
const molduraVazio = document.getElementById("moldura-vazio");
const arquivoCamera = document.getElementById("arquivo-camera");

const mensagemEspera = document.getElementById("mensagem-espera");
const progresso = document.getElementById("progresso");

const imagemResultado = document.getElementById("imagem-resultado");
const btnBaixar = document.getElementById("btn-baixar");
const tituloResultado = document.getElementById("titulo-resultado");

const mensagemErro = document.getElementById("mensagem-erro");

// --- estado ----------------------------------------------------------------
/** Data URL da foto já reduzida, pronta para enviar. */
let fotoReduzida = null;

/**
 * A legenda que vai junto da imagem compartilhada.
 *
 * O endereço vem de window.location.origin, e não escrito à mão: assim o link
 * que circula é sempre o do domínio por onde a pessoa entrou. Se um dia a feira
 * sair do staging para o domínio definitivo, nada aqui precisa mudar.
 */
const MENSAGEM_COMPARTILHAR =
  "Feira Cultural Instituto Americana, como a IA está revolucionando o nosso dia.\n\n" +
  window.location.origin;

// --- telas -----------------------------------------------------------------
function mostrarTela(tela) {
  for (const t of [telaForm, telaEspera, telaResultado, telaErro]) t.hidden = t !== tela;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- validação do formulário ----------------------------------------------
function estiloEscolhido() {
  return document.querySelector('input[name="estilo"]:checked')?.value ?? null;
}

function atualizarBotao() {
  btnGerar.disabled = !(
    campoNome.value.trim() &&
    campoProfissao.value.trim() &&
    estiloEscolhido() &&
    fotoReduzida
  );
}

[campoNome, campoProfissao].forEach((campo) =>
  campo.addEventListener("input", atualizarBotao),
);

// Destaca o cartão do estilo escolhido e revalida.
const cartoesEstilo = Array.from(document.querySelectorAll(".estilo"));

function marcarEstilos() {
  for (const cartao of cartoesEstilo) {
    cartao.setAttribute("aria-pressed", String(cartao.querySelector("input").checked));
  }
}

document.querySelectorAll('input[name="estilo"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    marcarEstilos();
    atualizarBotao();
  });
});

marcarEstilos();

// --- foto ------------------------------------------------------------------
// A moldura inteira abre a câmera. Como ela é uma <div> e não um <button>,
// o role/tabindex vêm do HTML e o teclado é tratado aqui: sem isto, quem navega
// por teclado (ou leitor de tela) não teria como tirar a foto.
const moldura = document.getElementById("moldura");
const molduraTrocar = document.getElementById("moldura-trocar");

function abrirCamera() {
  arquivoCamera.click();
}

moldura.addEventListener("click", abrirCamera);

moldura.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" || evento.key === " ") {
    evento.preventDefault();
    abrirCamera();
  }
});

arquivoCamera.addEventListener("change", () => {
  const arquivo = arquivoCamera.files?.[0];
  // Zera o input depois de ler. Sem isto, repetir a MESMA foto não dispara o
  // change de novo e a moldura parece não responder em quem quer refazer.
  arquivoCamera.value = "";
  if (arquivo) receberFoto(arquivo);
});

/** Liga e desliga o estado "já tem foto" da moldura. */
function mostrarPrevia(temFoto) {
  previa.hidden = !temFoto;
  molduraVazio.hidden = temFoto;
  molduraTrocar.hidden = !temFoto;
}

async function receberFoto(arquivo) {
  if (!arquivo.type.startsWith("image/")) {
    return falhar("Esse arquivo não é uma imagem. Escolha uma foto.");
  }
  try {
    fotoReduzida = await reduzirFoto(arquivo);
    previa.src = fotoReduzida;
    mostrarPrevia(true);
    atualizarBotao();
  } catch (falha) {
    console.error(falha);
    falhar("Não consegui abrir essa foto. Tente outra.");
  }
}

/**
 * Reduz a foto para caber em LADO_MAX e devolve um data URL em JPEG.
 * Feito com <img> + <canvas> em vez de createImageBitmap porque funciona em
 * todos os navegadores de celular, inclusive Safari antigo.
 */
function reduzirFoto(arquivo) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
        const largura = Math.max(1, Math.round(img.width * escala));
        const altura = Math.max(1, Math.round(img.height * escala));

        const canvas = document.createElement("canvas");
        canvas.width = largura;
        canvas.height = altura;

        const ctx = canvas.getContext("2d");
        // Fundo branco: se a foto tiver transparência, o JPEG a tornaria preta.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, largura, altura);
        ctx.drawImage(img, 0, 0, largura, altura);

        resolve(canvas.toDataURL("image/jpeg", QUALIDADE_JPEG));
      } catch (falha) {
        reject(falha);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não consegui ler a imagem."));
    };

    img.src = url;
  });
}

// --- geração ---------------------------------------------------------------
btnGerar.addEventListener("click", gerar);

async function gerar() {
  mostrarTela(telaEspera);
  const pararMensagens = animarEspera();

  try {
    const resposta = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nome: campoNome.value.trim(),
        profissao: campoProfissao.value.trim(),
        estilo: estiloEscolhido(),
        foto: fotoReduzida,
      }),
    });

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok || !dados.imagem) {
      throw new Error(dados.erro || "Não consegui gerar o seu personagem. Tente de novo.");
    }

    progresso.style.width = "100%";
    imagemResultado.src = dados.imagem;
    btnBaixar.href = dados.imagem;
    // A extensão sai do tipo que o servidor devolveu, não de um palpite. Fixar
    // ".png", como era antes, gerava um arquivo .png que por dentro era JPEG.
    btnBaixar.download = nomeDoArquivo(dados.imagem);
    avisoCompartilhar.hidden = true;
    tituloResultado.textContent = campoNome.value.trim()
      ? `${campoNome.value.trim()}, olha você aí!`
      : "Olha você aí!";

    // Espera a imagem carregar antes de trocar de tela, senão pisca em branco.
    await new Promise((ok) => {
      if (imagemResultado.complete) return ok();
      imagemResultado.onload = ok;
      imagemResultado.onerror = ok;
    });

    mostrarTela(telaResultado);
    telaResultado.classList.add("entrar");
  } catch (falha) {
    console.error(falha);
    // Quando o fetch em si falha (sem sinal, wi-fi caindo, ou o corte de 60s do
    // Safari), o navegador joga um TypeError com mensagem em inglês — o iPhone
    // diz só "Load failed". Traduz para algo que o visitante entenda.
    falhar(
      falha instanceof TypeError
        ? "A conexão falhou. Confira o wi-fi ou os dados do celular e tente de novo."
        : falha.message,
    );
  } finally {
    pararMensagens();
  }
}

/** Barra + mensagens rotativas, para os 10–20s de espera não parecerem travar. */
function animarEspera() {
  progresso.style.width = "0%";
  // Como não há progresso real, a barra avança até 90% e só completa no fim.
  const passos = [12, 26, 42, 58, 72, 84, 90];
  let i = 0;
  const avanco = setInterval(() => {
    progresso.style.width = `${passos[Math.min(i, passos.length - 1)]}%`;
    i += 1;
  }, 1800);

  mensagemEspera.textContent = MENSAGENS_ESPERA[0];
  let m = 1;
  const troca = setInterval(() => {
    mensagemEspera.textContent = MENSAGENS_ESPERA[m % MENSAGENS_ESPERA.length];
    m += 1;
  }, 3500);

  return () => {
    clearInterval(avanco);
    clearInterval(troca);
  };
}

function falhar(mensagem) {
  mensagemErro.textContent = mensagem || "Algo deu errado. Tente de novo.";
  mostrarTela(telaErro);
}

/**
 * Nome do arquivo para baixar, com a extensão certa.
 * O servidor devolve image/jpeg ou image/png conforme o modelo, então a
 * extensão vem da própria resposta.
 */
function nomeDoArquivo(dataUrl) {
  const tipo = (dataUrl.match(/^data:([^;]+);/) ?? [])[1] ?? "image/jpeg";
  const extensao = { "image/png": "png", "image/webp": "webp" }[tipo] ?? "jpg";
  const apelido = (campoNome.value.trim() || "feira")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `personagem-${apelido || "feira"}.${extensao}`;
}

// --- compartilhar ----------------------------------------------------------
const btnCompartilhar = document.getElementById("btn-compartilhar");
const avisoCompartilhar = document.getElementById("aviso-compartilhar");

btnCompartilhar.addEventListener("click", async () => {
  const blob = dataUrlParaBlob(imagemResultado.src);
  if (!blob) return;

  const arquivo = new File([blob], nomeDoArquivo(imagemResultado.src), { type: blob.type });

  // navigator.share com arquivo é o único caminho que anexa a imagem de fato:
  // o link wa.me, sozinho, carrega apenas texto. Como o celular é o aparelho do
  // estande, este é o caminho normal — e a folha que abre deixa a pessoa
  // escolher o WhatsApp.
  if (navigator.canShare?.({ files: [arquivo] })) {
    try {
      await navigator.share({ files: [arquivo], text: MENSAGEM_COMPARTILHAR });
    } catch (falha) {
      // AbortError é a pessoa fechando a folha sem escolher nada. Não é erro.
      if (falha?.name !== "AbortError") console.error(falha);
    }
    return;
  }

  // Computador e navegadores antigos não sabem compartilhar arquivo. Aqui abre
  // o WhatsApp já com a legenda, e a pessoa anexa a imagem na conversa.
  window.open(
    `https://wa.me/?text=${encodeURIComponent(MENSAGEM_COMPARTILHAR)}`,
    "_blank",
    "noopener",
  );
  avisoCompartilhar.hidden = false;
});

/**
 * Converte um data URL em Blob.
 *
 * Tudo aqui é síncrono de propósito: o navegador só permite abrir a folha de
 * compartilhamento enquanto o toque ainda está "ativo", e um await no meio
 * desta conversão consumiria esse direito — a folha simplesmente não abriria.
 */
function dataUrlParaBlob(dataUrl) {
  const partes = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!partes) return null;
  const [, tipo, b64] = partes;
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: tipo });
}

// --- voltar -----------------------------------------------------------------
document.getElementById("btn-voltar").addEventListener("click", () => mostrarTela(telaForm));

document.getElementById("btn-refazer").addEventListener("click", () => {
  // Mantém nome e profissão (a pessoa provavelmente quer só tentar outro
  // estilo), mas limpa a foto e o estilo para forçar uma escolha nova.
  fotoReduzida = null;
  // removeAttribute e não src = "": atribuir string vazia faz alguns
  // navegadores pedirem a própria página como se fosse imagem.
  previa.removeAttribute("src");
  mostrarPrevia(false);
  document.querySelectorAll('input[name="estilo"]').forEach((radio) => {
    radio.checked = false;
  });
  marcarEstilos();
  atualizarBotao();
  mostrarTela(telaForm);
});

atualizarBotao();
