import { api } from "./api-client";

/**
 * Leva o navegador à tela de consentimento do Google para conectar a conta.
 *
 * Pede a URL à API com o token de sessão no **header** e só então navega. O
 * caminho antigo — `window.location.href = ".../auth/google?token=" + jwt` —
 * punha a sessão na barra de endereço, de onde ela vai para o histórico do
 * navegador, para o `Referer` de qualquer requisição saindo da página e para o
 * log de acesso de todo intermediário.
 *
 * Não existe fallback para o caminho antigo, de propósito: ele reintroduziria
 * exatamente o vazamento que esta função elimina. Se a API ainda estiver numa
 * versão sem `POST /auth/google/url` — a janela entre o deploy do Render e o da
 * Vercel, que saem do mesmo merge em tempos diferentes — o botão falha e avisa,
 * em vez de vazar calado.
 */
export async function conectarGoogle(): Promise<void> {
  const { url } = await api.googleAuthUrl();
  window.location.href = url;
}
