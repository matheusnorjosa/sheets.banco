"use client";

import { useEffect, useRef } from "react";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";

const ONBOARDING_KEY = "sheets-banco-onboarded";

function isOnboarded(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

function markOnboarded() {
  localStorage.setItem(ONBOARDING_KEY, "true");
}

export function useOnboarding() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current || isOnboarded()) return;
    started.current = true;

    // Small delay to ensure DOM is ready
    const timeout = setTimeout(() => {
      const driverObj = driver({
        showProgress: true,
        animate: true,
        overlayColor: "rgba(0, 0, 0, 0.6)",
        popoverClass: "sb-popover",
        steps: [
          {
            popover: {
              title: "Bem-vindo ao sheets.banco!",
              description:
                "Transforme qualquer Google Sheet em uma API REST completa em segundos. Vamos fazer um tour.",
            },
          },
          {
            element: "[data-onboard='nav-apis']",
            popover: {
              title: "Suas APIs",
              description:
                "Este é o seu painel principal. Todas as suas APIs conectadas ao Google Sheets aparecem aqui.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='nav-stats']",
            popover: {
              title: "Estatísticas",
              description:
                "Veja análises de uso, contagem de requisições e métricas de desempenho de todas as suas APIs.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='theme-toggle']",
            popover: {
              title: "Alternar Tema",
              description:
                "Alterne entre o modo escuro e claro conforme sua preferência.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='create-api']",
            popover: {
              title: "Crie Sua Primeira API",
              description:
                'Clique aqui para conectar uma Google Sheet. Basta colar a URL e dar um nome — sua API REST estará pronta instantaneamente.',
              side: "bottom",
              align: "end",
            },
          },
          {
            popover: {
              title: "Tudo Pronto!",
              description:
                "Crie sua primeira API para começar. Você terá endpoints para ler, criar, atualizar e excluir dados — além de recursos como cache, webhooks, chaves de API e muito mais.",
            },
          },
        ],
        onDestroyStarted: () => {
          markOnboarded();
          driverObj.destroy();
        },
      });

      driverObj.drive();
    }, 500);

    return () => clearTimeout(timeout);
  }, []);
}

/**
 * Reset onboarding so it shows again on next page load.
 */
export function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
}
