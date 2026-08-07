# NZN Quiz 6.8.32

Atualização baseada na 6.8.31.

## Ajustes

- removido o atalho **Caixa de suporte** do menu do perfil;
- adicionado **Criar usuário** ao menu superior para ADM Master;
- removido o rótulo pequeno **Editor de quiz** acima do título;
- removida a barra flutuante de finalização/salvamento;
- editor de quiz reconstruído em formato guiado;
- apenas uma questão fica aberta por vez;
- navegação por números das questões;
- indicador visual das questões já preenchidas;
- botões Anterior e Próxima;
- botão **Salvar quiz** fica apenas no final da página, sem sobreposição.

## Atualização

Substitua `server.js` e `package.json` no GitHub e faça **Manual Deploy → Clear build cache & deploy** no Render.

Confira `/health`: `version` deve ser `6.8.32`.
