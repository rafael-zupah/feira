/**
 * Configuração do PM2 — Feira Cultural
 *
 * Uso no VPS:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     (para sobreviver a um reboot do servidor)
 *
 * O PM2 exige a extensão .cjs aqui porque o package.json tem "type": "module"
 * e este arquivo é CommonJS.
 */
module.exports = {
  apps: [
    {
      name: "feira",
      script: "server.js",

      // cwd explícito e derivado deste arquivo: o PM2 pode ser chamado de
      // qualquer diretório, e o server.js procura o .env ao lado dele.
      cwd: __dirname,

      // UMA instância só, de propósito.
      //
      // O limite de 5 gerações por pessoa a cada 10 minutos vive num Map dentro
      // da memória do processo. Com duas instâncias, cada uma teria o seu
      // próprio Map e o limite valeria 10 — e, pior, o visitante levaria erro
      // dependendo de qual instância o sorteasse. Com API paga, isso é dinheiro.
      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      max_memory_restart: "300M",

      // watch fica desligado: com ele o PM2 reinicia a cada arquivo que muda,
      // inclusive os de log, o que derruba o estande no meio de uma geração.
      watch: false,

      // Sem timezone explícita, os logs saem em UTC e confundem na hora de
      // correlacionar com o horário do estande.
      time: true,
      merge_logs: true,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
