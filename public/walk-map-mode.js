// Compact selectable points apply only to the CityWalk editor iframe.
if (new URLSearchParams(location.search).get("walk") === "1")
  document.body.classList.add("walk-edit");
