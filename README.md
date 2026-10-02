# Feira Cultural — Gerador de Personagens

Webapp de estande de feira cultural. O visitante abre um link pelo QR code, informa
nome e profissão, escolhe um estilo, manda uma selfie e recebe uma imagem dele mesmo
caracterizado — gerada por IA.

## Como funciona

O caminho da geração usa duas IA gratuitas, cada uma fazendo o que sabe fazer melhor:

```
selfie ──▶ Gemini Flash (visão)         ──▶ descrição detalhada da pessoa
       ──▶ FLUX.2 klein (Workers AI)    ──▶ imagem do personagem
```

O Gemini é os **olhos**: ele olha a foto e escreve, em inglês, um prompt com a aparência
real da pessoa (cabelo, óculos, tom de pele, barba, roupa). O FLUX é a **mão**: recebe esse
texto mais a foto e desenha.

Nada disso custa dinheiro. As duas cotas são gratuitas e não pedem cartão de crédito.

| Serviço | Cota gratuita | O que faz aqui |
|---|---|---|
| Gemini 2.5 Flash | ~15 req/min, 1500/dia | Lê a foto e escreve o prompt |
| Cloudflare Workers AI (FLUX.2 klein 4B) | 10.000 neurons/dia ≈ **96 imagens/dia** | Desenha o personagem |
| Cloudflare Workers | 100.000 req/dia | Serve a página e a API |

### Duas limitações que você precisa saber

1. **A semelhança é "inspirada", não fiel.** O FLUX.2 klein aceita foto de entrada com
   menos de 512×512, então detalhe fino do rosto se perde. Quem carrega a semelhança é a
   descrição em texto do Gemini. O personagem lembra a pessoa; não é um retrato dela.
   Se um dia precisar de rosto fiel, troque o provedor de imagem por Nano Banana 2
   (`gemini-2.5-flash-image`), que custa ~US$ 0,045 por imagem — a arquitetura já está
   isolada para essa troca ser feita em `src/worker.js`.

2. **A cota é de ~96 imagens por dia.** Ela renova à 00:00 UTC, que é **21h de Brasília** —
   ou seja, o dia da feira já começa com a cota cheia. Quando acaba, o app avisa em
   português em vez de quebrar. Acompanhe o consumo no painel da Cloudflare.

## Instalação

Você precisa do **Node.js** (uma vez só). No PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Feche e reabra o PowerShell, e confirme:

```powershell
node -v
```

Agora o projeto:

```powershell
  cd c:\projetos\ia
  npm install --save-dev --save-exact wrangler
  npx wrangler login
```

O `login` abre o navegador para você autorizar a Cloudflare. Crie a conta antes em
[dash.cloudflare.com](https://dash.cloudflare.com) — o plano gratuito basta e não pede cartão.

## Como a Cloudflare autentica — você NÃO precisa de chave de API

Esta é a parte que mais confunde, então vale ser explícito: **não existe chave da Cloudflare
para configurar neste projeto.** Nem no código, nem em arquivo, nem em variável de ambiente.

Cada coisa que precisa de permissão autentica por um caminho diferente:

| O que precisa | Quem autentica | Como |
|---|---|---|
| Publicar e atualizar o Worker | `wrangler login` | OAuth: abre o navegador, você clica em *Allow* uma vez, e o wrangler guarda o token dele |
| Rodar a IA (FLUX) | binding `AI` | A Cloudflare liga o Worker ao Workers AI pela configuração; nenhum token envolvido |
| Servir a página | binding `assets` | Também só configuração em `wrangler.jsonc` |
| Ler a foto (Gemini) | `GEMINI_API_KEY` | Essa sim é uma chave — mas é do **Google**, não da Cloudflare |

Ou seja: o único segredo deste projeto é a chave do Google. Para a Cloudflare, o comando é um só:

```powershell
npx wrangler login
```

### Se o `wrangler login` não funcionar na sua máquina

Raro, mas acontece com proxy ou navegador bloqueado. O substituto é um token criado na hora,
com permissão **mínima**:

1. *My Profile* → *API Tokens* → *Create Token* → *Custom token*
2. Permissões: **Workers Scripts → Edit** e **Account Settings → Read**. Só essas duas.
3. Não marque Workers AI, KV, R2 nem nada de conta.

E ele vai em **variável de ambiente**, nunca no código, nunca em arquivo versionado e nunca
colado em conversa:

```powershell
$env:CLOUDFLARE_API_TOKEN = "..."   # vale só nesta janela do PowerShell
npm run deploy
```

> Um token colado em chat, e-mail ou issue deve ser apagado no mesmo dia,
> independentemente de quem viu. Token de API é senha.

## A chave do Gemini

Pegue uma chave gratuita em [aistudio.google.com](https://aistudio.google.com) →
*Get API key*. Ela **não** vai em nenhum arquivo do projeto: fica guardada como segredo
no servidor da Cloudflare.

```powershell
npx wrangler secret put GEMINI_API_KEY
```

Cole a chave quando ele pedir. Para rodar localmente, crie um arquivo `.dev.vars`
(que já está no `.gitignore`) com uma linha:

```
GEMINI_API_KEY=sua_chave_aqui
```

## Rodar no seu computador

```powershell
npm run dev
```

Abra o endereço que aparecer (normalmente `http://localhost:8787`). Para testar do celular
na mesma rede wi-fi, use `npx wrangler dev --ip 0.0.0.0` e acesse pelo IP do PC.

## Publicar (o link do QR code)

```powershell
npm run deploy
```

Ele devolve uma URL do tipo `https://feira-personagens.SEU-USUARIO.workers.dev`.
Esse é o link que vira QR code para o estande.

Depois de publicar, rode o segredo de novo se ainda não rodou — o segredo vai para a versão
publicada, não para a local.

## Antes de confiar no app: rode a sonda

Existe uma página de diagnóstico em `/sonda.html`. **Não pule isso.** Ela responde as
perguntas que decidem se o app vai funcionar:

1. **Teste básico** — confirma que o Worker consegue falar com o Workers AI.
2. **Teste com foto** — escolha uma selfie e vá subindo o tamanho (512, 640, 768, 1024).
   Quando começar a dar erro, você achou o limite real de tamanho do modelo. A sonda
   devolve a mensagem de erro crua justamente para isso.

Se o limite for mesmo 512px, o `LADO_MAX` em `public/app.js` já está certo. Se aceitar mais,
aumente lá — vai melhorar a semelhança de graça.

A sonda também mostra quanto tempo cada geração leva. Anote: é o número que você vai dizer
para o visitante no estande.

## Operação no dia da feira

- **Antes de abrir**: rode 2 ou 3 gerações de teste para confirmar que a cota está de pé e
  quanto tempo está levando naquele dia.
- **Consumo**: painel da Cloudflare → Workers & Pages → Workers AI. Se estiver perto de
  10.000 neurons, a cota do dia está no fim.
- **Se acabar a cota**: o visitante vê uma mensagem explicando. Ela renova às 21h.
- **Antiabuso**: há um limite de 5 gerações por pessoa a cada 10 minutos, em memória. É
  uma trava grossa — não divulgue o link fora do QR do estande.

## Privacidade

Este ponto importa, porque as fotos são de visitantes e provavelmente incluem menores.

- A foto **nunca é gravada**: não vai para disco, KV, R2 nem para os logs. Ela existe apenas
  na memória enquanto aquela requisição é atendida.
- Mesmo assim, a foto **sai para terceiros**: Google (Gemini) e Cloudflare. Na cota gratuita
  e fora da Europa, o Google pode usar os dados enviados para melhorar os modelos dele.
  Isso está escrito na tela, em texto curto, e o visitante precisa marcar um aceite antes
  de gerar.
- Recomendações para o estande: peça só o **primeiro nome ou apelido**, e deixe um cartaz
  de consentimento visível para os responsáveis.

## Estrutura

```
wrangler.jsonc    configuração do Worker (assets + binding de IA)
src/worker.js     a API: validação, prompt no Gemini, imagem no FLUX, sonda
public/index.html a página do visitante
public/app.js     lógica da página: reduz a foto, envia, mostra o resultado
public/sonda.html página de diagnóstico
```

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `node` não é reconhecido | Node instalado mas o PowerShell não foi reaberto |
| "Falta configurar a chave do Gemini" | Rodou `wrangler secret put` mas está testando local sem `.dev.vars` |
| "O modelo ... não foi encontrado" | O id do modelo mudou; atualize `GEMINI_MODEL` em `src/worker.js` |
| "A cota gratuita de imagens de hoje acabou" | Os 10.000 neurons do dia acabaram; renova às 21h de Brasília |
| Semelhança ruim | Esperado nesta arquitetura gratuita; veja a limitação 1 acima |
