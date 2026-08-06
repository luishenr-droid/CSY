# NZN Quiz 6.8.22

Esta versão foi construída sobre a base 6.8.20 com FAQ e suporte da 6.8.21.

## Melhorias

- sino removido;
- notificação de suporte posicionada na foto do perfil;
- textos secundários removidos do menu do perfil;
- página individual para cada usuário;
- alteração entre Instrutor e ADM Master;
- consulta de último login, criação da conta, status e prazos;
- bloqueio e desbloqueio pela página do usuário;
- consulta da senha temporária gerada, quando ainda estiver ativa;
- geração de nova senha temporária;
- página individual para cada resultado;
- dashboard com início, finalização, duração e participantes;
- gráfico de aproveitamento;
- gráfico de acertos e erros;
- lista completa dos participantes e desempenho individual.

## Segurança das senhas

A senha pessoal atual nunca é exibida. O ADM Master visualiza apenas a senha temporária gerada pelo sistema enquanto ela ainda estiver ativa. Depois que o usuário cria a própria senha, ela deixa de ficar disponível. O Master pode gerar uma nova senha temporária quando necessário.

## Atualização

Substitua no GitHub:

- `server.js`
- `package.json`

No Render, use:

- Manual Deploy
- Clear build cache & deploy

Confira em `/health`:

```json
"version": "6.8.22"
```

O PostgreSQL criará automaticamente a coluna usada para proteger senhas temporárias. Nenhum usuário, quiz, resultado ou chamado existente será apagado.
