import "./App.css";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { MeetingPage } from "./pages/MeetingPage";

function MeetingRoute() {
  const { id } = useParams();
  return <MeetingPage key={id} />;
}

function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/meetings/:id" element={<MeetingRoute />} />
    <Route path="*" element={<HomePage />} />
  </Routes></BrowserRouter>;
}

export default App;
