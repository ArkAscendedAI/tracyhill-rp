import { useQuery } from "@tanstack/react-query";

import { getCampaigns } from "./campaignApi";

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: getCampaigns,
  });
}
