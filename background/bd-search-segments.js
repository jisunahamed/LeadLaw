/** Loaded via importScripts from background.js */

(function () {
  const BANGLADESH_DISTRICTS = [
    "Dhaka",
    "Chattogram",
    "Chittagong",
    "Khulna",
    "Rajshahi",
    "Sylhet",
    "Barishal",
    "Barisal",
    "Rangpur",
    "Mymensingh",
    "Gazipur",
    "Narayanganj",
    "Cumilla",
    "Comilla",
    "Jessore",
    "Jashore",
    "Bogra",
    "Bogura",
    "Dinajpur",
    "Faridpur",
    "Jamalpur",
    "Kushtia",
    "Noakhali",
    "Tangail",
    "Pabna",
    "Sirajganj",
    "Feni",
    "Lakshmipur",
    "Chandpur",
    "Manikganj",
    "Munshiganj",
    "Narsingdi",
    "Shariatpur",
    "Rajbari",
    "Madaripur",
    "Gopalganj",
    "Bagerhat",
    "Satkhira",
    "Narail",
    "Magura",
    "Meherpur",
    "Chuadanga",
    "Jhenaidah",
    "Natore",
    "Naogaon",
    "Joypurhat",
    "Thakurgaon",
    "Panchagarh",
    "Nilphamari",
    "Lalmonirhat",
    "Kurigram",
    "Gaibandha",
    "Sherpur",
    "Netrokona",
    "Sunamganj",
    "Habiganj",
    "Moulvibazar",
    "Brahmanbaria",
    "Cox's Bazar",
    "Coxs Bazar",
    "Bandarban",
    "Rangamati",
    "Khagrachhari",
    "Patuakhali",
    "Barguna",
    "Bhola",
    "Jhalokati",
    "Pirojpur"
  ];

  const DHAKA_AREAS = [
    "Gulshan 1",
    "Gulshan 2",
    "Banani",
    "Baridhara",
    "Bashundhara",
    "Uttara Sector 1",
    "Uttara Sector 3",
    "Uttara Sector 4",
    "Uttara Sector 7",
    "Uttara Sector 9",
    "Uttara Sector 10",
    "Uttara Sector 11",
    "Uttara Sector 12",
    "Uttara Sector 13",
    "Uttara Sector 14",
    "Dhanmondi",
    "Mohammadpur",
    "Mirpur 1",
    "Mirpur 2",
    "Mirpur 3",
    "Mirpur 6",
    "Mirpur 7",
    "Mirpur 10",
    "Mirpur 11",
    "Mirpur 12",
    "Mirpur 13",
    "Mirpur 14",
    "Pallabi",
    "Kallyanpur",
    "Farmgate",
    "Tejgaon",
    "Motijheel",
    "Gulistan",
    "Paltan",
    "Ramna",
    "Shahbagh",
    "Wari",
    "Old Dhaka",
    "Lalbagh",
    "Azimpur",
    "Khilgaon",
    "Badda",
    "Rampura",
    "Hatirjheel",
    "Demra",
    "Jatrabari",
    "Shyampur",
    "Sutrapur",
    "Cantonment",
    "Nikunja 1",
    "Nikunja 2",
    "Khilkhet",
    "Airport",
    "Turag",
    "Savar",
    "Ashulia",
    "Keraniganj",
    "Dohar",
    "Nawabganj Dhaka",
    "Elephant Road",
    "New Market",
    "Eskaton",
    "Maghbazar",
    "Malibagh",
    "Shantinagar",
    "Kakrail",
    "Bijoy Sarani",
    "Agargaon",
    "Shewrapara",
    "Kazipara",
    "Ibrahimpur",
    "Kafrul",
    "Banasree",
    "Aftabnagar",
    "Merul Badda",
    "Kuril",
    "Joar Sahara",
    "Vatara",
    "Solmaid",
    "Green Road",
    "Panthapath",
    "Kathalbagan",
    "Kalabagan",
    "Sukrabad",
    "Sobhanbagh",
    "Shankar",
    "Jafrabad",
    "Hazaribagh",
    "Kamrangirchar",
    "Postagola",
    "Jurain",
    "Gendaria",
    "Sayedabad",
    "Mugda",
    "Basabo",
    "Goran",
    "Madartek",
    "Nandipara",
    "Dakshinkhan",
    "Uttarkhan"
  ];

  self.LH_buildSearchPlan = function LH_buildSearchPlan(keyword, location) {
    const raw = String(location || "").trim();
    const loc = raw.toLowerCase().replace(/\s+/g, " ");
    const kw = String(keyword || "").trim();
    const singleQuery = `${kw} ${raw}`.trim();

    const bdOnly =
      /^(all\s+)?bangladesh$/i.test(raw) ||
      loc === "bangladesh" ||
      loc === "whole bangladesh" ||
      loc === "all bangladesh";

    if (bdOnly) {
      const seen = new Set();
      const segments = [];
      for (const d of BANGLADESH_DISTRICTS) {
        const key = d.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        segments.push(`${kw} ${d} Bangladesh`.trim());
      }
      return { mode: "districts", segments };
    }

    const isDhaka = /\bdhaka\b/i.test(raw) || loc.includes("dhaka") || loc.includes("dacca");

    if (isDhaka && !bdOnly) {
      const segments = DHAKA_AREAS.map((a) => `${kw} ${a} Dhaka Bangladesh`.trim());
      return { mode: "dhaka_areas", segments };
    }

    return { mode: "single", segments: [singleQuery] };
  };

  self.LH_mapsSearchUrlForQuery = function LH_mapsSearchUrlForQuery(query) {
    return `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  };
})();
