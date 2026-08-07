# NZN Quiz 6.8.26 — Correção do pódio final

Esta versão corrige somente a sequência visual do pódio final.

- vencedores não ficam mais presentes visualmente antes da hora da revelação;
- terceiro e segundo lugares aparecem em sequência;
- primeiro lugar só é inserido na tela depois de “Que rufem os tambores”;
- removido o efeito que podia causar sensação de tremor no campeão;
- protegida a animação contra renderizações repetidas durante o estado final;
- limite de 500 participantes e todo o restante da 6.8.25 permanecem iguais.

## Atualizar
Substitua `server.js` e `package.json` no GitHub e faça `Manual Deploy > Clear build cache & deploy` no Render.

Confira `/health`: versão `6.8.26`.
