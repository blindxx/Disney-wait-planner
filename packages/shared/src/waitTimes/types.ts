import type { ParkId } from "../index";

export interface AttractionWait {
  id: string;
  name: string;
  parkId: ParkId;
  waitTime: number; // in minutes
  isOperational: boolean;
  lastUpdated: string; // ISO 8601 timestamp
  themeParksId: string;
}
