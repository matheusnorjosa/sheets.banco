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
              title: "Welcome to sheets.banco!",
              description:
                "Turn any Google Sheet into a full REST API in seconds. Let us show you around.",
            },
          },
          {
            element: "[data-onboard='nav-apis']",
            popover: {
              title: "Your APIs",
              description:
                "This is your main dashboard. All your connected Google Sheets APIs appear here.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='nav-stats']",
            popover: {
              title: "Statistics",
              description:
                "View usage analytics, request counts, and performance metrics across all your APIs.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='theme-toggle']",
            popover: {
              title: "Theme Toggle",
              description:
                "Switch between dark and light mode to suit your preference.",
              side: "right",
              align: "center",
            },
          },
          {
            element: "[data-onboard='create-api']",
            popover: {
              title: "Create Your First API",
              description:
                'Click here to connect a Google Sheet. Just paste the URL and give it a name — your REST API is ready instantly.',
              side: "bottom",
              align: "end",
            },
          },
          {
            popover: {
              title: "You're All Set!",
              description:
                "Create your first API to get started. You'll get endpoints for reading, creating, updating, and deleting data — plus features like caching, webhooks, API keys, and more.",
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
