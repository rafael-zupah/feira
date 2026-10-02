# Feira Cultural — Gerador de Personagens

Webapp de estande de feira cultural. O visitante abre um link pelo QR code, informa
nome e profissão, escolhe um estilo, manda uma selfie e recebe uma imagem dele mesmo
caracterizado — gerada por IA.

## Como funciona

Tudo acontece numa chamada só:

```
selfie + estilo ──▶ gemini-3.1-flash-image ──▶ imagem do personagem
```

O modelo **lê a foto e desenha**, no mesmo passo. Como ele vê o rosto de verdade, o
personagem sai parecido com a pessoa — que é o ponto inteiro da brincadeira. A versão
anterior deste app usava duas IAs em sequência (uma descrevia a pessoa em texto, outra
desenhava a partir do texto) e por isso a semelhança era só "inspirada". Essa limitação
acabou.

A foto **nunca é gravada**: não vai para disco, banco nem log. Ela existe apenas na
memória enquanto aquela requisição é atendida.

## Quanto custa — leia isto antes de qualquer coisa

**US$ 0,067 por imagem gerada** (1K). Esta é a mudança mais importante em relação à
versão anterior deste README, que dizia que nada custava dinheiro:

- **Não existe cota gratuita.** A geração de imagem saiu do tier grátis do Google em
  dezembro de 2025. A página oficial de preços marca "Not available" na coluna de
  gratuito para todos os modelos de imagem.
- **A conta precisa de cobrança ativa.** Sem billing, a chave responde `429` em
  *todas* as chamadas — e o sintoma é indistinguível de "muita gente usando".
- **O limite de gasto é a cota do projeto**, não o código. No Tier 1 o Google atende
  cerca de 10 imagens por minuto e algumas centenas por dia. Confira os números do
  *seu* projeto em [aistudio.google.com](https://aistudio.google.com) → *Usage*, porque
  as cotas mudam e variam por conta.

Para dimensionar: **300 imagens ≈ US$ 20**. Um dia de feira costuma ficar nessa faixa.

Contas de referência:

| Cenário | Imagens | Custo |
|---|---|---|
| Feira de uma tarde | ~150 | ~US$ 10 |
| Feira o dia inteiro | ~300 | ~US$ 20 |
| Link vazado, dia inteiro | ~1.000 (teto da cota) | ~US$ 67 |

> O app tem um limite de **5 gerações por pessoa a cada 10 minutos**, em memória, para
> uma pessoa sozinha não queimar o orçamento. Ele **não** é um teto diário: não existe
> trava de gasto total no código. Se quiser um teto rígido, configure um orçamento no
> Google Cloud (Faturamento → Orçamentos e alertas).

## O que você precisa

- O VPS com **Node.js 20 ou superior** e **Nginx**
- O domínio apontando para o VPS (`feira.staging.veruh.com.br` já aponta)
- Uma **chave do Gemini com cobrança ativa**, de [aistudio.google.com](https://aistudio.google.com)
- PM2 (`npm install -g pm2`)

> Não confunda os dois diretórios: **no seu computador** o projeto está em
> `/var/www/html/particular/feira`; **no VPS** ele vai em `/var/www/html/feira`.
> Todos os caminhos deste README são os do VPS.

## Deploy no VPS

### 1. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

Instale pelo apt, e não pelo nvm: o `pm2 startup` grava o caminho do Node no systemd, e
com nvm esse caminho quebra quando você atualiza o Node.

### 2. O código

```bash
sudo mkdir -p /var/www/html/feira
sudo chown -R "$USER":"$USER" /var/www/html/feira
git clone git@github.com:rafael-zupah/feira.git /var/www/html/feira
cd /var/www/html/feira
```

Se o VPS não tiver chave SSH para o GitHub, copie do seu computador em vez de clonar:

```bash
rsync -av --exclude node_modules --exclude .git \
  /var/www/html/particular/feira/ usuario@187.127.54.68:/var/www/html/feira/
```

### 3. A chave

```bash
cd /var/www/html/feira
cp .env.example .env
nano .env          # cole a chave em GEMINI_API_KEY=
chmod 600 .env     # só o seu usuário lê
```

O `.env` está no `.gitignore` e **nunca** deve ser versionado. Chave de API é senha.

### 4. Teste na mão, antes do PM2

```bash
cd /var/www/html/feira
node server.js
```

Se houver qualquer erro de configuração, ele aparece aqui — direto na sua frente, e não
escondido dentro do PM2. Deve imprimir:

```
Feira no ar em http://127.0.0.1:8090
Modelo de imagem: gemini-3.1-flash-image (US$ 0,067 por imagem)
```

Se aparecer a linha `ATENÇÃO: GEMINI_API_KEY não está definida`, o `.env` não foi lido —
confira o passo 3. Deixe rodando e, **noutro terminal**:

```bash
curl -s localhost:8090/api/health
# {"ok":true,"modelo":"gemini-3.1-flash-image"}
```

Este endereço é barato e não gasta nada. Depois pare o processo com `Ctrl+C`.

### 5. PM2

```bash
cd /var/www/html/feira
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup      # e rode o comando que ele imprimir
```

O `pm2 save` guarda a lista de processos e o `pm2 startup` faz ela voltar sozinha se o
VPS reiniciar. **Sem os dois, uma queda de energia no dia da feira deixa o estande fora
do ar** até alguém entrar por SSH.

Comandos do dia a dia:

```bash
pm2 status                 # está de pé?
pm2 logs feira             # o que está acontecendo (Ctrl+C para sair)
pm2 restart feira          # depois de mudar o código
```

> O `ecosystem.config.cjs` roda **uma instância só**, de propósito. O limite de 5
> gerações por pessoa vive na memória do processo; com duas instâncias, cada uma teria
> o seu próprio contador e o limite valeria 10 — com API paga, isso é dinheiro a mais.

### 6. Nginx

```bash
sudo cp /var/www/html/feira/deploy/nginx.conf \
        /etc/nginx/sites-available/feira.staging.veruh.com.br
sudo ln -s /etc/nginx/sites-available/feira.staging.veruh.com.br \
           /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

O `nginx -t` antes do reload é obrigatório: se o arquivo tiver um erro de sintaxe, o
reload falharia e o Nginx continuaria com a configuração antiga — inclusive para os
outros sites do servidor.

O arquivo traz os detalhes que decidem se funciona: o `proxy_pass` sem barra no fim (com
barra, `/api/generate` viraria `/generate` e tudo daria 404), o `proxy_read_timeout` de
180s (o padrão de 60s mataria a resposta no meio de uma geração) e o `X-Real-IP` vindo do
`$remote_addr` (é ele que faz o limite por pessoa valer).

### 7. HTTPS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d feira.staging.veruh.com.br
```

O certbot reescreve o arquivo do Nginx acrescentando o bloco da porta 443 e o
redirecionamento de HTTP para HTTPS. Escolha a opção de redirecionar.

O site **precisa** ser HTTPS: sem o cadeado, o navegador do celular marca a página como
insegura e o QR code no estande perde credibilidade com os responsáveis.

Confira a renovação automática (o certificado vence em 90 dias):

```bash
sudo certbot renew --dry-run
```

### 8. Atualizações depois

```bash
cd /var/www/html/feira
git pull
pm2 restart feira
```

## Antes de abrir: rode a sonda

Existe uma página de diagnóstico em `/sonda.html`. **Não pule isto.** Ela responde as
perguntas que decidem se o app vai funcionar no dia:

1. **Teste básico** — confirma que o servidor conversa com o Gemini. Um `429` aqui quase
   sempre quer dizer **conta sem cobrança ativa**, não excesso de uso.
2. **Teste com uma selfie** — é este que mostra se o personagem sai parecido. O tempo em
   `ms` é o número que você vai dizer para o visitante na fila.

Se algo falhar, a sonda devolve a **resposta crua do Google**. É de propósito: é
exatamente a informação necessária para descobrir o que está errado.

> **Este é o único ponto do projeto que eu não pude testar.** A forma exata do corpo da
> requisição (`generationConfig.responseModalities`) não dá para validar sem uma chave
> real — o Google checa a autenticação antes de olhar o corpo. Se o teste básico
> devolver `400 INVALID_ARGUMENT`, é aí que está o problema, e o campo a ajustar é o
> `generationConfig` em `src/worker.js`.

## Operação no dia da feira

- **Antes de abrir**: rode 2 ou 3 gerações de teste para confirmar que a cobrança está de
  pé e quanto tempo está levando naquele dia.
- **Consumo**: [aistudio.google.com](https://aistudio.google.com) → *Usage*. Não existe
  mais o painel de neurons da Cloudflare.
- **Se aparecer "Muita gente gerando ao mesmo tempo"**: a cota por minuto do projeto
  estourou. O app já enfileira até 3 gerações simultâneas e repete uma vez sozinho; se
  ainda assim aparecer, é fila de verdade — peça para esperar um minuto.
- **Sem teto de gasto**: não há trava de consumo total no código. Acompanhe o painel.
- **Antiabuso**: 5 gerações por pessoa a cada 10 minutos. É uma trava grossa — não
  divulgue o link fora do QR do estande.

## Privacidade

Este ponto importa, porque as fotos são de visitantes e provavelmente incluem menores.

- A foto **nunca é gravada**: não vai para disco, banco nem para os logs. Ela existe
  apenas na memória enquanto aquela requisição é atendida.
- Mesmo assim, a foto **sai para terceiros**: o Google, que a recebe para gerar a imagem.
  Na API paga, o Google declara não usar os dados enviados para treinar modelos — mas
  isso é política deles, não uma garantia técnica nossa. O aviso aparece na tela, em uma
  linha abaixo do botão, sem exigir clique nenhum: um aceite obrigatório travava a fila
  do estande, porque muita gente não percebia que precisava marcar a caixinha.
- Se um visitante fechar a aba no meio da geração, o app **cancela a chamada** ao Google
  em vez de deixá-la terminar e ser cobrada à toa.
- Recomendações para o estande: peça só o **primeiro nome ou apelido**, e deixe um cartaz
  de consentimento visível para os responsáveis.

## Estrutura

```
server.js              a ponte Node: converte req/res para Request/Response e chama o app
src/worker.js          o app: validação, chamada ao Gemini, sonda
public/index.html      a página do visitante
public/app.js          lógica da página: reduz a foto, envia, mostra o resultado
public/sonda.html      página de diagnóstico
ecosystem.config.cjs   configuração do PM2
deploy/nginx.conf      bloco do Nginx (copiar para /etc/nginx/sites-available/)
.env.example           modelo do arquivo de segredos
wrangler.jsonc         plano B na Cloudflare (veja o fim do README)
```

O `src/worker.js` é escrito na API padrão de Request/Response — a mesma do navegador.
Por isso o mesmo arquivo roda no Node (via `server.js`) e num Worker da Cloudflare, sem
nenhuma alteração.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `node: command not found` | Node não instalado, ou instalado via nvm e o PM2 não enxerga |
| `ATENÇÃO: GEMINI_API_KEY não está definida` | O `.env` não existe ou está com o nome errado |
| `429` em **todas** as gerações | Conta do Google sem cobrança ativa — não é excesso de uso |
| `403` e a chave parece certa | `.env` editado no Windows deixou um `\r` no fim da linha |
| `502 Bad Gateway` no navegador | O processo do Node caiu: `pm2 status` e `pm2 logs feira` |
| `504` / "A geração demorou demais" | Passou de 50s. Veja o `ms` na sonda |
| iPhone mostra "A conexão falhou" | O Safari corta em 60s; o app já desiste aos 50s |
| `400 INVALID_ARGUMENT` na sonda | Ajuste o `generationConfig` em `src/worker.js` |
| `404` em tudo que é `/api/` | `proxy_pass` com barra no fim; veja `deploy/nginx.conf` |
| Semelhança ruim | Foto escura, de lado, ou muito pequena — teste lados maiores na sonda |
| Mudou o código e nada mudou | Faltou `pm2 restart feira` |
| Depois de reiniciar o VPS sumiu | Faltou `pm2 save` **e** `pm2 startup` |

## Plano B: Cloudflare Workers

O `wrangler.jsonc` continua no repositório. Como o `src/worker.js` é escrito em
Request/Response padrão, **o mesmo código** roda num Worker da Cloudflare sem alteração
nenhuma — só a chave, que lá vai como segredo:

```bash
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Serve como emergência se o VPS der problema no dia do evento. A cobrança do Gemini é a
mesma; o que muda é quem serve a página.

## Notas de projeto

- A foto é reduzida para 1024px no celular antes de subir (`LADO_MAX` em `public/app.js`).
  O valor anterior era 512, que era o limite do modelo antigo — e era justamente o que
  estragava a semelhança.
- O botão "Tirar foto" usa `capture="user"`, que abre a câmera frontal direto no celular,
  sem passar pela galeria. **Em computador o atributo é ignorado** e o navegador abre o
  seletor de arquivos — é assim que dá para testar o app no PC.
- Uma imagem 1K consome ~1.120 tokens de saída. O `maxOutputTokens` é 8192; um valor
  baixo como 512 faria toda geração voltar cortada e sem imagem.
- O app nunca envia `imageConfig`. A documentação do Google está em transição e há
  relatos de `imageSize` ser ignorado; aceitar o padrão (1K) evita a briga.
