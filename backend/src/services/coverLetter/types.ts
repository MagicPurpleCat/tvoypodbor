import type { VacancyFull } from '../hh.js';

export interface Resume {
  full_name: string;
  desired_position: string;
  city: string | null;
  contacts: { phone?: string; email?: string; telegram?: string };
  experience: { company: string; position: string; from: string; to: string | null; achievements?: string }[];
  skills: string[];
  education: { institution: string; degree?: string; year?: number }[];
  portfolio: { title: string; url: string }[];
  about: string;
}

export type Tone = 'formal' | 'friendly' | 'short';

export interface CoverLetterInput {
  vacancy: VacancyFull;
  resume: Resume;
  tone: Tone;
}

export interface CoverLetterProvider {
  name: string;
  generate(input: CoverLetterInput): Promise<string>;
}
