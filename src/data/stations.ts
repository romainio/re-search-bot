/**
 * Stations de métro, RER et Transilien autour des zones (Île-de-France Mobilités, jeu emplacement-des-gares-idf, ODbL). Une
 * entrée par zone de correspondance, position moyenne de ses quais ; seules les stations à moins de 800 m des zones sont gardées,
 * pour ne pas désigner une station lointaine à une annonce en bordure.
 */
export interface Station {
  name: string;
  lines: string[];
  lat: number;
  lon: number;
}
export const STATIONS: readonly Station[] = [
  { name: "Abbesses", lines: ["12"], lat: 48.88459, lon: 2.33795 },
  { name: "Anatole France", lines: ["3"], lat: 48.89208, lon: 2.28501 },
  { name: "Argentine", lines: ["1"], lat: 48.87534, lon: 2.29013 },
  { name: "Asnières-sur-Seine", lines: ["Transilien J", "Transilien L"], lat: 48.9059, lon: 2.28311 },
  { name: "Blanche", lines: ["2"], lat: 48.88356, lon: 2.33338 },
  { name: "Brochant", lines: ["13"], lat: 48.89059, lon: 2.32017 },
  { name: "Bécon les Bruyères", lines: ["Transilien L"], lat: 48.90576, lon: 2.26996 },
  { name: "Charles de Gaulle - Etoile", lines: ["1", "2", "6", "RER A"], lat: 48.87473, lon: 2.29551 },
  { name: "Clichy - Levallois", lines: ["Transilien L"], lat: 48.89764, lon: 2.29742 },
  { name: "Courcelles", lines: ["2"], lat: 48.87933, lon: 2.30407 },
  { name: "Europe", lines: ["3"], lat: 48.87877, lon: 2.32227 },
  { name: "Gare Saint-Lazare", lines: ["14", "Transilien J", "Transilien L"], lat: 48.87646, lon: 2.32457 },
  { name: "Garibaldi", lines: ["13"], lat: 48.90609, lon: 2.33183 },
  { name: "George V", lines: ["1"], lat: 48.87202, lon: 2.30056 },
  { name: "Guy-Môquet", lines: ["13"], lat: 48.89221, lon: 2.32722 },
  { name: "Kléber", lines: ["6"], lat: 48.87126, lon: 2.29324 },
  { name: "La Fourche", lines: ["13"], lat: 48.88718, lon: 2.32578 },
  { name: "Les Sablons", lines: ["1"], lat: 48.88102, lon: 2.27224 },
  { name: "Liège", lines: ["13"], lat: 48.87963, lon: 2.32702 },
  { name: "Louise Michel", lines: ["3"], lat: 48.88871, lon: 2.28808 },
  { name: "Mairie de Clichy", lines: ["13"], lat: 48.90323, lon: 2.30601 },
  { name: "Malesherbes", lines: ["3"], lat: 48.88289, lon: 2.30905 },
  { name: "Miromesnil", lines: ["13"], lat: 48.87377, lon: 2.31446 },
  { name: "Monceau", lines: ["2"], lat: 48.88033, lon: 2.30877 },
  { name: "Pigalle", lines: ["12"], lat: 48.88225, lon: 2.33716 },
  { name: "Place de Clichy", lines: ["2", "13"], lat: 48.8839, lon: 2.32789 },
  { name: "Pont Cardinet", lines: ["14", "Transilien L"], lat: 48.88889, lon: 2.31445 },
  { name: "Pont de Levallois", lines: ["3"], lat: 48.89715, lon: 2.28041 },
  { name: "Porte Maillot", lines: ["1", "RER C", "RER E"], lat: 48.8778, lon: 2.28352 },
  { name: "Porte de Champerret", lines: ["3"], lat: 48.88601, lon: 2.29353 },
  { name: "Porte de Clichy", lines: ["13", "14", "RER C"], lat: 48.89447, lon: 2.31405 },
  { name: "Porte de Saint-Ouen", lines: ["13"], lat: 48.89737, lon: 2.32894 },
  { name: "Péreire", lines: ["3", "RER C"], lat: 48.88547, lon: 2.2985 },
  { name: "Rome", lines: ["2"], lat: 48.88233, lon: 2.3218 },
  { name: "Saint-Ouen", lines: ["14", "RER C"], lat: 48.90453, lon: 2.32218 },
  { name: "Ternes", lines: ["2"], lat: 48.87797, lon: 2.29831 },
  { name: "Victor Hugo", lines: ["2"], lat: 48.8698, lon: 2.28534 },
  { name: "Villiers", lines: ["2", "3"], lat: 48.88109, lon: 2.31472 },
  { name: "Wagram", lines: ["3"], lat: 48.88381, lon: 2.30467 },
];
